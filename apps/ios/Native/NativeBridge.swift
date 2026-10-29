import UIKit
import WebKit

@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    let entry: URL
    weak var controller: WorkbenchController?
    private let store = CredentialStore()
    private var client: RemoteHTTP?
    private var candidate: (invitation: Invitation, registration: Registration)?
    private var requests: [String: Task<Void, Never>] = [:]
    private var subscription: (id: String, task: Task<Void, Never>?, socket: URLSessionWebSocketTask)?
    private var terminal: TerminalConnection?
    private var active = true
    private var generation = 0

    init(entry: URL) { self.entry = entry }

    func permits(mainFrame: Bool, url: URL?) -> Bool { mainFrame && url == entry }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard permits(mainFrame: message.frameInfo.isMainFrame, url: message.frameInfo.request.url),
              message.webView === controller?.webview,
              let body = message.body as? [String: String], Set(body.keys).isSubset(of: ["operation", "id", "tabId", "terminalSessionId", "sequence"]),
              let operation = body["operation"], active,
              Set(body.keys).isSubset(of: operation == "terminal-open" ? ["operation", "id", "tabId", "terminalSessionId"] : operation == "terminal-ack" ? ["operation", "id", "sequence"] : ["operation", "id"])
        else { replyHandler(["state": "unavailable"], nil); return }
        let readId = ReadProcedure(rawValue: operation) == nil ? nil : body["id"]
        let task = Task {
            defer { if let readId { requests.removeValue(forKey: readId) } }
            do {
                let value = try await perform(operation, id: body["id"], fields: body)
                replyHandler(["state": "ok", "value": value], nil)
            } catch is DecodingError {
                replyHandler(["state": "incompatible"], nil)
            } catch {
                replyHandler(["state": (error as? RemoteFailure)?.state ?? "unavailable"], nil)
            }
        }
        if let readId { requests[readId] = task }
    }

    func suspend() {
        active = false
        candidate = nil
        generation += 1
        for task in requests.values { task.cancel() }
        requests.removeAll()
        if let subscription { emit(id: subscription.id, state: "unavailable") }
        unsubscribe()
        if let terminal { Task { _ = await terminal.close() } }
        terminal = nil
        client?.close()
        client = nil
    }

    func resume() { active = true }

    private func connection() throws -> RemoteHTTP {
        guard active else { throw RemoteFailure.unavailable }
        if let client { return client }
        guard let registration = try store.load() else { throw RemoteFailure.approvalRequired }
        let opened = RemoteHTTP(registration)
        client = opened
        return opened
    }

    private func perform(_ operation: String, id: String?, fields: [String: String]) async throws -> Any {
        if let procedure = ReadProcedure(rawValue: operation) {
            guard let id, UUID(uuidString: id) != nil else { throw RemoteFailure.unavailable }
            return try JSONSerialization.jsonObject(with: await connection().read(procedure))
        }
        switch operation {
        case "terminal-open":
            guard let id, UUID(uuidString: id) != nil,
                  let tab = fields["tabId"], let session = fields["terminalSessionId"],
                  !tab.isEmpty, tab.utf8.count <= 128, !session.isEmpty, session.utf8.count <= 128
            else { throw RemoteFailure.unavailable }
            if let terminal { guard await terminal.close() else { throw RemoteFailure.unavailable } }
            guard active else { throw RemoteFailure.unavailable }
            let opened = TerminalConnection(id: id, socket: try connection().terminal())
            terminal = opened
            do { try await opened.open(tab: tab, session: session) }
            catch { _ = await opened.close(); throw error }
            guard active, terminal === opened else { _ = await opened.close(); throw RemoteFailure.unavailable }
            return NSNull()
        case "terminal-next":
            guard let terminal, terminal.id == id else { throw RemoteFailure.unavailable }
            return try await terminal.next()
        case "terminal-ack":
            guard let terminal, terminal.id == id, let sequence = fields["sequence"].flatMap(Int.init) else { throw RemoteFailure.unavailable }
            try await terminal.ack(sequence)
            return NSNull()
        case "terminal-close":
            guard let terminal, terminal.id == id else { return false }
            let confirmed = await terminal.close()
            if self.terminal === terminal { self.terminal = nil }
            return confirmed
        case "scan":
            guard let controller else { throw RemoteFailure.unavailable }
            candidate = nil
            guard let captured = try await controller.scan() else { return ["state": "cancelled"] }
            guard active else { throw RemoteFailure.unavailable }
            let invitation = try JSONDecoder().decode(Invitation.self, from: Data(captured.utf8))
            let registration = try invitation.registration(credential: CredentialStore.secret())
            candidate = (invitation, registration)
            return ["state": "candidate", "expiresAt": invitation.expiresAt]
        case "register":
            guard let candidate else { throw RemoteFailure.unavailable }
            self.candidate = nil
            let (invitation, registration) = candidate
            try store.save(registration)
            if let terminal { _ = await terminal.close(); self.terminal = nil }
            unsubscribe()
            client?.close()
            client = nil
            generation += 1
            let client = try connection()
            let current = generation
            let response = try await client.register(invitation: invitation.invitation, name: UIDevice.current.name)
            guard current == generation, active else { throw RemoteFailure.unavailable }
            let parsed = try JSONDecoder().decode(RegistrationResponse.self, from: response)
            if let expiresAt = parsed.expiresAt {
                guard expiresAt.isFinite, expiresAt >= 0 else { throw RemoteFailure.incompatible }
                var saved = registration
                saved.pendingUntil = Date(timeIntervalSince1970: expiresAt / 1000)
                try store.save(saved)
            }
            return parsed.value()
        case "registration":
            guard let registration = try store.load() else { return ["state": "unregistered"] }
            let current = generation
            var result: [String: Any]
            do {
                let data = try await connection().status()
                result = try JSONDecoder().decode(RegistrationResponse.self, from: data).value()
            } catch let error as RemoteFailure where error.state == "approval-required" {
                result = ["state": "unauthorized"]
            }
            guard current == generation, active else { throw RemoteFailure.unavailable }
            result["id"] = String(current)
            result["lifecycle"] = registration.lifecycle?.rawValue ?? "unknown"
            result["pendingUntil"] = registration.pendingUntil.timeIntervalSince1970 * 1000
            return result
        case "registration-approved":
            guard id == String(generation), var registration = try store.load() else { throw RemoteFailure.unavailable }
            registration.lifecycle = .approved
            try store.save(registration)
            return NSNull()
        case "subscribe":
            guard let id, UUID(uuidString: id) != nil else { throw RemoteFailure.unavailable }
            unsubscribe()
            let client = try connection()
            let socket = try client.changes()
            generation += 1
            let current = generation
            subscription = (id, nil, socket)
            do {
                let acknowledgement = try await socket.receive()
                guard current == generation, active else { throw RemoteFailure.unavailable }
                let message = try decode(acknowledgement)
                guard message == "subscribed" else { throw RemoteFailure.incompatible }
            } catch {
                let stillCurrent = current == generation && active
                unsubscribe(id: id)
                guard stillCurrent else { throw RemoteFailure.unavailable }
                // WSS upgrade errors omit the HTTP status; the same authenticated unary classifies revocation.
                _ = try await client.read(.layout)
                throw error
            }
            let task = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        guard let self, current == self.generation else { return }
                        let decoded = try self.decode(message)
                        guard decoded == "changed" else { throw RemoteFailure.incompatible }
                        self.emit(id: id, state: "changed")
                    }
                } catch {
                    guard let self, !Task.isCancelled, current == self.generation else { return }
                    var state = (error as? RemoteFailure)?.state ?? "unavailable"
                    do { _ = try await client.read(.layout) }
                    catch { state = (error as? RemoteFailure)?.state ?? "unavailable" }
                    self.emit(id: id, state: state)
                    self.unsubscribe(id: id)
                }
            }
            subscription = (id, task, socket)
            return NSNull()
        case "cancel":
            if let id { requests[id]?.cancel() }
            return NSNull()
        case "unsubscribe":
            if let id { unsubscribe(id: id) }
            return NSNull()
        default: throw RemoteFailure.unavailable
        }
    }

    private struct ChangeMessage: Decodable {
        let version: Int
        let type: String
    }

    private func decode(_ message: URLSessionWebSocketTask.Message) throws -> String {
        guard case .string(let text) = message, text.utf8.count <= 65_536 else { throw RemoteFailure.incompatible }
        let decoded = try JSONDecoder().decode(ChangeMessage.self, from: Data(text.utf8))
        guard decoded.version == 1 else { throw RemoteFailure.incompatible }
        return decoded.type
    }

    private func unsubscribe(id: String? = nil) {
        guard let subscription, id == nil || subscription.id == id else { return }
        self.subscription = nil
        generation += 1
        subscription.task?.cancel()
        subscription.socket.cancel(with: .goingAway, reason: nil)
    }

    private func emit(id: String, state: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "state": state]),
              let json = String(data: data, encoding: .utf8) else { return }
        controller?.webview?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('monica-change',{detail:\(json)}))", completionHandler: nil)
    }
}
