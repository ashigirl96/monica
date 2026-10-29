import Foundation

@MainActor
final class TerminalConnection {
    let id: String
    private let socket: URLSessionWebSocketTask
    private var receiving: Task<URLSessionWebSocketTask.Message, Error>?
    private var closing: Task<Bool, Never>?
    private var stopped = false
    private var confirmed = false

    init(id: String, socket: URLSessionWebSocketTask) {
        self.id = id
        self.socket = socket
    }

    func open(tab: String, session: String) async throws {
        try await send(["type": "open", "tabId": tab, "terminalSessionId": session])
    }

    private func send(_ value: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        guard data.count <= 65_536, let text = String(data: data, encoding: .utf8) else { throw RemoteFailure.incompatible }
        try await socket.send(.string(text))
    }

    private func decode(_ message: URLSessionWebSocketTask.Message) throws -> [String: Any] {
        guard case .string(let text) = message, text.utf8.count <= 65_536,
              let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              value["version"] as? Int == 1 else { throw RemoteFailure.incompatible }
        return value
    }

    func next() async throws -> Any {
        guard !stopped, receiving == nil else { throw RemoteFailure.unavailable }
        let task = Task { try await socket.receive() }
        receiving = task
        defer { receiving = nil }
        let message = try await task.value
        guard !stopped else { throw RemoteFailure.unavailable }
        let value = try decode(message)
        if value["type"] as? String == "closed" { confirmed = true }
        return value
    }

    func ack(_ sequence: Int) async throws {
        guard !stopped, sequence > 0 else { throw RemoteFailure.unavailable }
        try await send(["type": "ack", "sequence": sequence])
    }

    func close() async -> Bool {
        if confirmed { socket.cancel(with: .normalClosure, reason: nil); return true }
        if let closing { return await closing.value }
        stopped = true
        let pending = receiving
        let task = Task { () -> Bool in
            let timeout = Task {
                try await Task.sleep(for: .seconds(3))
                socket.cancel(with: .goingAway, reason: nil)
            }
            defer { timeout.cancel(); socket.cancel(with: .goingAway, reason: nil) }
            do {
                try await send(["type": "close"])
                if let pending, try decode(await pending.value)["type"] as? String == "closed" { return true }
                while true {
                    let value = try decode(await socket.receive())
                    if value["type"] as? String == "closed" { return true }
                }
            } catch { return false }
        }
        closing = task
        return await task.value
    }
}
