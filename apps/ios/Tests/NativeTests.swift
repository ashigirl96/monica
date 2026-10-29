import XCTest
import WebKit
import CryptoKit
@testable import Monica

final class NativeTests: XCTestCase {
    struct Fixture: Decodable {
        let endpoint: URL
        let certificate: Data
        let credential: String
    }
    func fixtures() throws -> [String: Fixture] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "fixtures", withExtension: "json"))
        return try JSONDecoder().decode([String: Fixture].self, from: Data(contentsOf: url))
    }
    func registration(_ fixture: Fixture, certificate: Data? = nil) -> Registration {
        Registration(endpoint: fixture.endpoint, certificate: certificate ?? fixture.certificate,
                     credential: fixture.credential, pendingUntil: Date().addingTimeInterval(300))
    }

    func testURLSessionValidHTTPSAndWSSAndWrongCredential() async throws {
        let f = try fixtures()["valid"]!
        XCTAssertTrue(Trust.accepts(certificate: f.certificate, host: "127.0.0.1"))
        let client = RemoteHTTP(registration(f))
        defer { client.close() }
        let data = try await client.read(.layout)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{\"runspaces\":[]}")
        let socket = client.changes()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        let message = try await socket.receive()
        guard case .string(let text) = message else { return XCTFail("Expected subscribe ACK") }
        XCTAssertTrue(text.contains("subscribed"))
        let bad = Registration(endpoint: f.endpoint, certificate: f.certificate,
                               credential: "monica-remote-v1." + String(repeating: "0", count: 64), pendingUntil: Date())
        let rejected = RemoteHTTP(bad)
        defer { rejected.close() }
        do { _ = try await rejected.read(.layout); XCTFail("Wrong credential accepted") }
        catch let error as RemoteFailure { XCTAssertEqual(error.state, "approval-required") }
    }

    func testURLSessionRejectsWrongIdentityExpiredHostnameAndRedirectBeforeCredentialLeaks() async throws {
        let f = try fixtures()
        for name in ["wrong-identity", "expired", "hostname", "redirect"] {
            let fixture = f[name]!
            let client = RemoteHTTP(registration(fixture))
            do { _ = try await client.read(.layout); XCTFail("Accepted \(name)") }
            catch let error as RemoteFailure { XCTAssertEqual(error.state, "identity-changed", name) }
            let socket = client.changes()
            do { _ = try await socket.receive(); XCTFail("WSS accepted \(name)") } catch { }
            socket.cancel(with: .goingAway, reason: nil)
            client.close()
        }
        let client = RemoteHTTP(registration(f["audit"]!))
        defer { client.close() }
        let data = try await client.read(.layout)
        let audit = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Int])
        XCTAssertEqual(audit["wrong-identity"], 0)
        XCTAssertEqual(audit["expired"], 0)
        XCTAssertEqual(audit["hostname"], 0)
        XCTAssertEqual(audit["redirect-target"], 0)
    }

    func testKeychainCredentialIsDeviceOnlyAndReadableAfterSave() throws {
        let store = CredentialStore(account: "test-" + UUID().uuidString)
        defer { try? store.remove() }
        let f = try fixtures()["valid"]!
        let saved = registration(f)
        try store.save(saved)
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.credential, saved.credential)
        XCTAssertEqual(loaded.certificate, saved.certificate)
        let attributes = try store.attributes()
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertNotEqual(try CredentialStore.secret(), try CredentialStore.secret())
    }

    func testQRValidatesWireVersionHostFingerprintAndInvitationExpiry() throws {
        let fixture = try fixtures()["qr"]!
        let fingerprint = SHA256.hash(data: fixture.certificate).map { String(format: "%02X", $0) }.joined(separator: ":")
        let syntheticAddress = [100, 64, 0, 1].map(String.init).joined(separator: ".")
        let valid: [String: Any] = ["version": 1, "endpoint": fixture.endpoint.absoluteString,
                                  "certificate": fixture.certificate.base64EncodedString(), "fingerprint": fingerprint,
                                  "invitation": String(repeating: "a", count: 64), "expiresAt": Date().addingTimeInterval(290).timeIntervalSince1970 * 1000]
        func parse(_ fields: [String: Any]) throws -> Registration {
            let data = try JSONSerialization.data(withJSONObject: fields)
            return try JSONDecoder().decode(Invitation.self, from: data).registration(credential: "test")
        }
        XCTAssertEqual(try parse(valid).endpoint, fixture.endpoint)
        for replacement in [["version": 2], ["fingerprint": "00"], ["expiresAt": 0],
                            ["endpoint": "http://\(syntheticAddress):19443"], ["endpoint": "https://example.com:19443"],
                            ["endpoint": "https://\(syntheticAddress):19443/?token=secret"]] as [[String: Any]] {
            XCTAssertThrowsError(try parse(valid.merging(replacement) { _, new in new }))
        }
    }

    func testWSSRevocationClosesSubscriptionAndRefusesNewReads() async throws {
        let f = try fixtures()["revoked"]!
        let client = RemoteHTTP(registration(f))
        defer { client.close() }
        let socket = client.changes()
        _ = try await socket.receive()
        _ = try await client.read(.terminalSessions)
        do { _ = try await socket.receive(); XCTFail("Revoked socket stayed open") } catch { }
        do { _ = try await client.read(.layout); XCTFail("Revoked credential accepted") }
        catch let error as RemoteFailure { XCTAssertEqual(error.state, "approval-required") }
        socket.cancel(with: .goingAway, reason: nil)
    }

    @MainActor
    func testBundledReactRunsInWKWebViewAndBridgeRejectsUntrustedOperationsAndFrames() async throws {
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(2))
        let webview = controller.webview!
        let title = try await webview.evaluateJavaScript("document.querySelector('h1')?.textContent") as? String
        XCTAssertEqual(title, "Workbench")
        let unknown = try await webview.callAsyncJavaScript("return (await window.webkit.messageHandlers.monica.postMessage({operation:'https://example.com'})).state", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(unknown, "unavailable")
        XCTAssertFalse(controller.bridge.permits(mainFrame: false, url: controller.entry))
        XCTAssertFalse(controller.bridge.permits(mainFrame: true, url: URL(string: "https://example.com")!))
        XCTAssertTrue(controller.bridge.permits(mainFrame: true, url: controller.entry))
        _ = try await webview.evaluateJavaScript("location.href='https://example.com'")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(webview.url, controller.entry)
        let containsSecret = try await webview.evaluateJavaScript("document.documentElement.innerHTML.includes('monica-remote-v1.')") as? Bool
        XCTAssertEqual(containsSecret, false)
        webview.navigationDelegate = nil
        webview.loadHTMLString("""
            <script>window.addEventListener('message', e => { window.frameResult = e.data })</script>
            <iframe srcdoc="<script>window.webkit.messageHandlers.monica.postMessage({operation:'registration'}).then(r=>parent.postMessage(r.state,'*'))</script>"></iframe>
            """, baseURL: nil)
        try await Task.sleep(for: .milliseconds(300))
        let frameResult = try await webview.evaluateJavaScript("window.frameResult") as? String
        XCTAssertEqual(frameResult, "unavailable")

    }
}
