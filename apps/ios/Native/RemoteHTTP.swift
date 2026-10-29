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

struct Registration: Codable, Sendable {
    let endpoint: URL
    let certificate: Data
    let credential: String
    let pendingUntil: Date

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
              Self.isTailscale(host), expiresAt > Date().timeIntervalSince1970 * 1000,
              expiresAt <= Date().addingTimeInterval(300).timeIntervalSince1970 * 1000 + 5000,
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

    private func request(_ path: String, post: Bool = false) -> URLRequest {
        var request = URLRequest(url: registration.endpoint.appendingPathComponent(path))
        request.httpMethod = post ? "POST" : "GET"
        request.setValue("Bearer \(registration.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "x-monica-wire-version")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    func read(_ procedure: ReadProcedure) async throws -> Data {
        try await perform(request("workbench/\(procedure.rawValue)"))
    }

    func register(invitation: String, name: String) async throws -> Data {
        var request = request("registration/request", post: true)
        request.setValue(invitation, forHTTPHeaderField: "x-monica-invitation")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["version": 1, "name": String(name.prefix(80))])
        return try await perform(request)
    }

    func status() async throws -> Data {
        var request = request("registration/status", post: true)
        request.httpBody = Data("{}".utf8)
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw RemoteFailure.unavailable }
            if response.statusCode == 401 { throw RemoteFailure.approvalRequired }
            if response.statusCode == 426 || response.statusCode == 400 { throw RemoteFailure.incompatible }
            if (300...399).contains(response.statusCode) { throw RemoteFailure.identityChanged }
            guard (200...299).contains(response.statusCode), data.count <= 65_536 else { throw RemoteFailure.unavailable }
            return data
        } catch let error as URLError {
            if trustLock.withLock({ trustRejected }) || [-1200, -1201, -1202, -1203, -1204, -1205, -1206].contains(error.errorCode) {
                throw RemoteFailure.identityChanged
            }
            throw RemoteFailure.unavailable
        }
    }

    func changes() -> URLSessionWebSocketTask {
        var request = request("workbench/changes")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"
        request.url = components.url!
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 65_536
        task.resume()
        return task
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
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
