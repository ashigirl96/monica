import Foundation
import Security
import CryptoKit
import Network

struct RemoteFailure: Error {
    let state: String
    static let unavailable = RemoteFailure(state: "unavailable")
    static let approvalRequired = RemoteFailure(state: "approval-required")
    static let identityChanged = RemoteFailure(state: "identity-changed")
    static let incompatible = RemoteFailure(state: "incompatible")
}

enum RegistrationLifecycle: String, Codable, Sendable {
    case pending, approved
}

struct RegistrationResponse: Decodable {
    enum State: String, Decodable { case approved, pending, rejected }
    let state: State
    let version: Int?
    let expiresAt: Double?

    func value() -> [String: Any] {
        var result: [String: Any] = ["state": state.rawValue]
        if let version { result["version"] = version }
        if let expiresAt { result["expiresAt"] = expiresAt }
        return result
    }
}

struct Registration: Codable, Sendable {
    let endpoint: URL
    let certificate: Data
    let credential: String
    var pendingUntil: Date
    var lifecycle: RegistrationLifecycle? = .pending

    var host: String { endpoint.host!.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) }
}

struct Invitation: Decodable {
    let version: Int
    let endpoint: URL
    let certificate: Data
    let fingerprint: String
    let invitation: String
    let expiresAt: Double

    func registration(credential: String) throws -> Registration {
        guard version == 1 else { throw RemoteFailure.incompatible }
        guard let host = endpoint.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
              endpoint.scheme == "https", endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil, endpoint.path.isEmpty,
              let port = endpoint.port, (1024...65535).contains(port),
              Self.isTailscale(host), expiresAt.isFinite, expiresAt >= 0,
              invitation.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              SHA256.hash(data: certificate).map({ String(format: "%02X", $0) }).joined(separator: ":") == fingerprint,
              Trust.accepts(certificate: certificate, host: host)
        else { throw RemoteFailure.identityChanged }
        return Registration(endpoint: endpoint, certificate: certificate, credential: credential,
                            pendingUntil: Date(timeIntervalSince1970: expiresAt / 1000))
    }

    private static func isTailscale(_ host: String) -> Bool {
        if let bytes = IPv4Address(host)?.rawValue { return bytes[0] == 100 && (64...127).contains(bytes[1]) }
        if let bytes = IPv6Address(host)?.rawValue { return Array(bytes.prefix(6)) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] }
        return false
    }
}

enum Trust {
    static func accepts(certificate data: Data, host: String) -> Bool {
        guard let certificate = SecCertificateCreateWithData(nil, data as CFData) else { return false }
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, host as CFString), &trust) == errSecSuccess,
              let trust else { return false }
        return accepts(trust: trust, anchor: data, host: host)
    }

    static func accepts(trust: SecTrust, anchor: Data, host: String) -> Bool {
        guard let certificate = SecCertificateCreateWithData(nil, anchor as CFData),
              let notBefore = SecCertificateCopyNotValidBeforeDate(certificate) as Date?,
              let notAfter = SecCertificateCopyNotValidAfterDate(certificate) as Date?,
              notBefore <= Date(), Date() < notAfter,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil),
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first
        else { return false }
        return SecCertificateCopyData(leaf) as Data == anchor
    }
}

enum ReadProcedure: String, CaseIterable {
    case layout = "layout/get"
    case terminalSessions = "terminalSession/list"
    case agentSessions = "agentSession/list"
}

final class RemoteHTTP: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let registration: Registration
    private var session: URLSession!
    private let trustLock = NSLock()
    private var trustRejected = false

    init(_ registration: Registration) {
        self.registration = registration
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func close() { session.invalidateAndCancel() }

    private func request(_ path: String, post: Bool = false) throws -> URLRequest {
        guard Trust.accepts(certificate: registration.certificate, host: registration.host) else { throw RemoteFailure.identityChanged }
        var request = URLRequest(url: registration.endpoint.appendingPathComponent(path))
        request.httpMethod = post ? "POST" : "GET"
        request.setValue("Bearer \(registration.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "x-monica-wire-version")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    func read(_ procedure: ReadProcedure) async throws -> Data {
        do { return try await snapshot(procedure) }
        catch let error as URLError { throw classify(error) }
    }

    private func snapshot(_ procedure: ReadProcedure) async throws -> Data {
        let (bytes, response) = try await session.bytes(for: request("workbench/\(procedure.rawValue)"), delegate: self)
        defer { bytes.task.cancel() }
        try validate(response)
        guard response.mimeType == "application/x-ndjson" else { throw RemoteFailure.incompatible }
        return try await withTaskCancellationHandler {
            var line = Data()
            var snapshot = Data()
            var index = 0
            var ended = false
            for try await byte in bytes {
                try Task.checkCancellation()
                guard !ended, line.count < 65_536 else { throw RemoteFailure.incompatible }
                if byte != 10 { line.append(byte); continue }
                guard let frame = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      integer(frame["version"]) == 1, let type = frame["type"] as? String else { throw RemoteFailure.incompatible }
                if type == "data" {
                    guard Set(frame.keys) == ["version", "type", "index", "data"], integer(frame["index"]) == index,
                          let encoded = frame["data"] as? String, let part = Data(base64Encoded: encoded),
                          !part.isEmpty, part.count <= 45 * 1024, snapshot.count + part.count <= 64 * 1024 * 1024
                    else { throw RemoteFailure.incompatible }
                    snapshot.append(part)
                    index += 1
                } else if type == "end" {
                    guard Set(frame.keys) == ["version", "type", "count"], integer(frame["count"]) == index else { throw RemoteFailure.incompatible }
                    ended = true
                } else { throw RemoteFailure.incompatible }
                line.removeAll(keepingCapacity: true)
            }
            guard ended, line.isEmpty else { throw RemoteFailure.incompatible }
            return snapshot
        } onCancel: { bytes.task.cancel() }
    }

    private func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return value as? Int
    }

    private func validate(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else { throw RemoteFailure.unavailable }
        if response.statusCode == 401 { throw RemoteFailure.approvalRequired }
        if response.statusCode == 426 || response.statusCode == 400 { throw RemoteFailure.incompatible }
        if (300...399).contains(response.statusCode) { throw RemoteFailure.identityChanged }
        guard (200...299).contains(response.statusCode) else { throw RemoteFailure.unavailable }
    }

    func register(invitation: String, name: String) async throws -> Data {
        var request = try request("registration/request", post: true)
        request.setValue(invitation, forHTTPHeaderField: "x-monica-invitation")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["version": 1, "name": String(name.prefix(80))])
        return try await perform(request)
    }

    func status() async throws -> Data {
        var request = try request("registration/status", post: true)
        request.httpBody = Data("{}".utf8)
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response)
            guard data.count <= 65_536 else { throw RemoteFailure.unavailable }
            return data
        } catch let error as URLError { throw classify(error) }
    }

    private func classify(_ error: URLError) -> RemoteFailure {
        if trustLock.withLock({ trustRejected }) || [-1200, -1201, -1202, -1203, -1204, -1205, -1206].contains(error.errorCode) {
            return .identityChanged
        }
        return .unavailable
    }

    func changes() throws -> URLSessionWebSocketTask {
        var request = try request("workbench/changes")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"
        request.url = components.url!
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 65_536
        task.resume()
        return task
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler: completionHandler)
    }

    private func authenticate(_ challenge: URLAuthenticationChallenge,
                              completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == registration.host,
              let trust = challenge.protectionSpace.serverTrust,
              Trust.accepts(trust: trust, anchor: registration.certificate, host: registration.host)
        else {
            trustLock.withLock { trustRejected = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
