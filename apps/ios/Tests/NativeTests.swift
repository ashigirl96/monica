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
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "fixtures", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([String: Fixture].self, from: Data(contentsOf: url))
    }
    func registration(_ fixture: Fixture, certificate: Data? = nil) -> Registration {
        Registration(endpoint: fixture.endpoint, certificate: certificate ?? fixture.certificate,
                     credential: fixture.credential, pendingUntil: Date().addingTimeInterval(300))
    }

    func testAppTransportSecurityLimitsCustomPinnedTrustToTailscaleIPRanges() throws {
        let ats = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any])
        let pinnedTrustException: [String: Any] = [
            "NSExceptionAllowsInsecureHTTPLoads": true,
            "NSExceptionMinimumTLSVersion": "TLSv1.2",
            "NSExceptionRequiresForwardSecrecy": true,
        ]
        let expected: [String: Any] = ["NSExceptionDomains": [
            "100.64.0.0/10": pinnedTrustException,
            "fd7a:115c:a1e0::/48": pinnedTrustException,
        ]]
        XCTAssertEqual(ats as NSDictionary, expected as NSDictionary)
    }

    func testURLSessionValidHTTPSAndWSSAndWrongCredential() async throws {
        let f = try fixtures()["valid"]!
        XCTAssertTrue(Trust.accepts(certificate: f.certificate, host: "127.0.0.1"))
        let client = RemoteHTTP(registration(f))
        defer { client.close() }
        let data = try await client.read(.layout)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{\"runspaces\":[]}")
        let socket = try client.changes()
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
            do {
                let socket = try client.changes()
                defer { socket.cancel(with: .goingAway, reason: nil) }
                _ = try await socket.receive()
                XCTFail("WSS accepted \(name)")
            } catch { }
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
        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved)) as! [String: Any]
        legacy.removeValue(forKey: "lifecycle")
        let oldRecord = try JSONDecoder().decode(Registration.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertNil(oldRecord.lifecycle)
        try store.save(oldRecord)
        XCTAssertNil(try store.load()?.lifecycle)
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
        XCTAssertEqual(try parse(valid.merging(["expiresAt": 0]) { _, new in new }).pendingUntil, Date(timeIntervalSince1970: 0))
        for replacement in [["version": 2], ["fingerprint": "00"], ["expiresAt": -1],
                            ["endpoint": "http://\(syntheticAddress):19443"], ["endpoint": "https://example.com:19443"],
                            ["endpoint": "https://\(syntheticAddress):19443/?token=secret"]] as [[String: Any]] {
            XCTAssertThrowsError(try parse(valid.merging(replacement) { _, new in new }))
        }
    }

    func testWSSRevocationClosesSubscriptionAndRefusesNewReads() async throws {
        let f = try fixtures()["revoked"]!
        let client = RemoteHTTP(registration(f))
        defer { client.close() }
        let socket = try client.changes()
        _ = try await socket.receive()
        _ = try await client.read(.terminalSessions)
        do { _ = try await socket.receive(); XCTFail("Revoked socket stayed open") } catch { }
        do { _ = try await client.read(.layout); XCTFail("Revoked credential accepted") }
        catch let error as RemoteFailure { XCTAssertEqual(error.state, "approval-required") }
        socket.cancel(with: .goingAway, reason: nil)
    }

    func testLargeRealLedgerSnapshotPreservesUTF8AcrossFramesAndRejectsIncompleteOrOversizedTransfers() async throws {
        let f = try fixtures()
        let client = RemoteHTTP(registration(f["large"]!))
        defer { client.close() }
        let data = try await client.read(.layout)
        XCTAssertGreaterThan(data.count, 65_536)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let runspaces = try XCTUnwrap(object["runspaces"] as? [[String: Any]])
        XCTAssertEqual(runspaces.count, 12)
        XCTAssertEqual(runspaces.last?["cwd"] as? String, "/simulator-11-" + String(repeating: "あ😀", count: 1000))
        for name in ["truncated", "oversized", "malformed"] {
            let broken = RemoteHTTP(registration(f[name]!))
            defer { broken.close() }
            do { _ = try await broken.read(.layout); XCTFail("Accepted \(name) transfer") }
            catch let error as RemoteFailure { XCTAssertEqual(error.state, "incompatible") }
        }
    }

    func testCancellingSnapshotReleasesTheActualHTTPBody() async throws {
        let f = try fixtures()
        let client = RemoteHTTP(registration(f["cancel"]!))
        let audit = RemoteHTTP(registration(f["audit"]!))
        defer { client.close(); audit.close() }
        let task = Task { try await client.read(.layout) }
        func counts() async throws -> [String: Int] {
            try JSONSerialization.jsonObject(with: await audit.read(.layout)) as! [String: Int]
        }
        for _ in 0..<20 {
            if try await counts()["cancel-started"] == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled transfer completed") } catch { }
        var cancelled = false
        for _ in 0..<20 {
            if try await counts()["cancelled"] == 1 { cancelled = true; break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(cancelled)
    }

    @MainActor
    func testApprovedRegistrationSurvivesElapsedPendingDeadlineRelaunchAndRevocationWhilePendingExpires() async throws {
        let fixtures = try fixtures()
        let store = CredentialStore()
        let fixture = fixtures["lifecycle"]!
        try store.save(Registration(endpoint: fixture.endpoint, certificate: fixture.certificate,
                                    credential: fixture.credential, pendingUntil: Date(timeIntervalSince1970: 0)))
        defer { try? store.remove() }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        func launch() async throws -> WorkbenchController {
            let controller = WorkbenchController()
            controller.loadViewIfNeeded()
            window.rootViewController = controller
            for _ in 0..<100 {
                if let count = try? await controller.webview!.evaluateJavaScript("document.querySelectorAll('article').length") as? Int, count == 12 { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            let count = try await controller.webview!.evaluateJavaScript("document.querySelectorAll('article').length") as? Int
            XCTAssertEqual(count, 12)
            return controller
        }
        let first = try await launch()
        XCTAssertEqual(try store.load()?.lifecycle, .approved)
        first.bridge.suspend()
        let relaunched = try await launch()
        defer { relaunched.bridge.suspend() }
        let control = RemoteHTTP(registration(fixtures["lifecycle-control"]!))
        defer { control.close() }
        _ = try await control.read(.terminalSessions)
        let webview = relaunched.webview!
        for _ in 0..<100 {
            if let text = try? await webview.evaluateJavaScript("document.querySelector('header [role=status]')?.textContent") as? String, text.contains("登録が失効") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let liveRevoked = try await webview.evaluateJavaScript("document.querySelector('header [role=status]').textContent") as? String
        XCTAssertTrue(liveRevoked?.contains("登録が失効") == true)
        _ = try await webview.evaluateJavaScript("""
            window.registrationChecks = 0;
            const handler = window.webkit.messageHandlers.monica;
            const original = handler.postMessage.bind(handler);
            handler.postMessage = async message => {
                const reply = await original(message);
                if (message.operation === 'registration') window.registrationChecks++;
                return reply;
            };
            document.querySelectorAll('button')[1].click();
            null;
            """)
        for _ in 0..<100 {
            if let checks = try? await webview.evaluateJavaScript("window.registrationChecks") as? Int, checks > 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let checks = try await webview.evaluateJavaScript("window.registrationChecks") as? Int
        XCTAssertEqual(checks, 1)
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let expired = try await webview.evaluateJavaScript("document.body.textContent.includes('登録の期限が切れました')") as? Bool
        XCTAssertEqual(expired, false, "Approved credentials must not expire with their old pending deadline")
        let status = try await webview.evaluateJavaScript("document.querySelector('header [role=status]').textContent") as? String
        XCTAssertTrue(status?.contains("登録が失効") == true)
        let count = try await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int
        XCTAssertEqual(count, 0)
        _ = try await webview.evaluateJavaScript("""
            window.revokedRequests = [];
            const revokedOriginal = window.webkit.messageHandlers.monica.postMessage.bind(window.webkit.messageHandlers.monica);
            window.webkit.messageHandlers.monica.postMessage = message => {
                if (['registration','subscribe','layout/get','terminal-open'].includes(message.operation)) window.revokedRequests.push(message.operation);
                return revokedOriginal(message);
            };
            null;
            """)
        relaunched.bridge.suspend()
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        relaunched.bridge.resume()
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let automaticRetries = try await webview.evaluateJavaScript("window.revokedRequests.length") as? Int
        XCTAssertEqual(automaticRetries, 0, "Revocation requires explicit action, not foreground retry")
        relaunched.bridge.suspend()
        let revokedRelaunch = WorkbenchController()
        revokedRelaunch.loadViewIfNeeded()
        window.rootViewController = revokedRelaunch
        defer { revokedRelaunch.bridge.suspend() }
        for _ in 0..<100 {
            if let text = try? await revokedRelaunch.webview!.evaluateJavaScript("document.querySelector('header [role=status]')?.textContent") as? String, text.contains("登録が失効") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let revokedExpired = try await revokedRelaunch.webview!.evaluateJavaScript("document.body.textContent.includes('登録の期限が切れました')") as? Bool
        XCTAssertEqual(revokedExpired, false)
        let revokedStatus = try await revokedRelaunch.webview!.evaluateJavaScript("document.querySelector('header [role=status]').textContent") as? String
        XCTAssertTrue(revokedStatus?.contains("登録が失効") == true)
        revokedRelaunch.bridge.suspend()
        let pending = fixtures["pending"]!
        try store.save(Registration(endpoint: pending.endpoint, certificate: pending.certificate,
                                    credential: pending.credential, pendingUntil: Date(timeIntervalSince1970: 0)))
        let awaiting = WorkbenchController()
        awaiting.loadViewIfNeeded()
        window.rootViewController = awaiting
        defer { awaiting.bridge.suspend() }
        for _ in 0..<100 {
            if let expired = try? await awaiting.webview!.evaluateJavaScript("document.body.textContent.includes('登録の期限が切れました')") as? Bool, expired == true { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let pendingExpired = try await awaiting.webview!.evaluateJavaScript("document.body.textContent.includes('登録の期限が切れました')") as? Bool
        XCTAssertEqual(pendingExpired, true)
    }

    @MainActor
    func testQRCancellationIsNotAConnectionFailure() {
        var cancelled = false
        let scanner = QRScanner { result in
            switch result {
            case .success(let captured):
                XCTAssertNil(captured)
                cancelled = true
            case .failure(let error): XCTFail("Cancellation failed: \(error)")
            }
        }
        scanner.perform(NSSelectorFromString("cancel"))
        XCTAssertTrue(cancelled)
    }

    @MainActor
    func testCancelledOrInvalidQRKeepsTheAvailableWorkbenchAndOneSubscription() async throws {
        let store = CredentialStore()
        let saved = registration(try fixtures()["large"]!)
        try store.save(saved)
        defer { try? store.remove() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        for _ in 0..<100 {
            if let count = try? await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int, count == 12 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        _ = try await webview.callAsyncJavaScript("document.querySelector('article button').click(); await new Promise(resolve => requestAnimationFrame(resolve))", arguments: [:], in: nil, contentWorld: .page)
        let before = try await webview.evaluateJavaScript("document.querySelector('[aria-label=Runspace一覧]').innerHTML") as? String
        XCTAssertNotNil(before)
        _ = try await webview.evaluateJavaScript("""
            window.scanReply = {state:'unavailable'};
            window.subscribeCount = 0;
            window.unsubscribeCount = 0;
            const handler = window.webkit.messageHandlers.monica;
            const original = handler.postMessage.bind(handler);
            handler.postMessage = message => {
                if (message.operation === 'scan') return Promise.resolve(window.scanReply);
                if (message.operation === 'subscribe') window.subscribeCount++;
                if (message.operation === 'unsubscribe') window.unsubscribeCount++;
                return original(message);
            };
            null;
            """)
        for reply in ["{state:'unavailable'}", "{state:'identity-changed'}", "{state:'incompatible'}", "{state:'ok',value:{state:'candidate',expiresAt:0}}", "{state:'ok',value:{state:'cancelled'}}"] {
            _ = try await webview.callAsyncJavaScript("""
                window.scanReply = \(reply);
                document.querySelector('button').click();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                """, arguments: [:], in: nil, contentWorld: .page)
            let after = try await webview.evaluateJavaScript("document.querySelector('[aria-label=Runspace一覧]')?.innerHTML") as? String
            XCTAssertEqual(after, before, reply)
            let status = try await webview.evaluateJavaScript("document.querySelector('header [role=status]').textContent") as? String
            XCTAssertEqual(status, "利用可能", reply)
            let alerts = try await webview.evaluateJavaScript("document.querySelectorAll('[role=alert]').length") as? Int
            XCTAssertEqual(alerts, reply.contains("cancelled") ? 0 : 1)
        }
        let subscriptions = try await webview.evaluateJavaScript("window.subscribeCount") as? Int
        let unsubscriptions = try await webview.evaluateJavaScript("window.unsubscribeCount") as? Int
        XCTAssertEqual(subscriptions, 0)
        XCTAssertEqual(unsubscriptions, 0)
        XCTAssertEqual(try store.load()?.credential, saved.credential)
    }

    @MainActor
    func testBundledReactRunsInWKWebViewAndBridgeRejectsUntrustedOperationsAndFrames() async throws {
        let store = CredentialStore()
        try store.save(registration(try fixtures()["large"]!))
        defer { try? store.remove() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        for _ in 0..<100 {
            if let count = try? await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int, count == 12 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let title = try await webview.evaluateJavaScript("document.querySelector('h1')?.textContent") as? String
        XCTAssertEqual(title, "Workbench")
        let listCount = try await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int
        XCTAssertEqual(listCount, 12)
        let firstButtonHeight = try await webview.evaluateJavaScript("document.querySelector('button').getBoundingClientRect().height") as? Double
        XCTAssertGreaterThanOrEqual(firstButtonHeight ?? 0, 44)
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let image = try await webview.takeSnapshot(configuration: configuration)
        let attachment = XCTAttachment(image: image)
        attachment.name = "Bundled Workbench with actual Ledger snapshot"
        attachment.lifetime = .keepAlways
        add(attachment)
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
    @MainActor
    func testPhoneXtermShowsReplayAndLiveWithoutRepliesClipboardOrResizeAndBackDetaches() async throws {
        let all = try fixtures()
        let store = CredentialStore()
        try store.save(registration(all["large"]!))
        defer { try? store.remove() }
        let control = RemoteHTTP(registration(all["terminal-control"]!))
        defer { control.close() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        func until(_ expression: String) async throws {
            for _ in 0..<100 {
                if let result = try? await webview.evaluateJavaScript(expression) as? Bool, result { return }
                try await Task.sleep(for: .milliseconds(50))
            }
            let state = try? await webview.evaluateJavaScript("document.querySelector('[aria-label=\"Terminal Sessionの閲覧\"] [role=status]')?.textContent")
            XCTFail("Never observed: \(expression); state \(String(describing: state))")
        }
        try await until("document.querySelectorAll('article').length === 12")
        let clipboard = UIPasteboard.general.items
        defer { UIPasteboard.general.items = clipboard }
        UIPasteboard.general.string = "explicit-user-copy"
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        try await until("document.body.textContent.includes('閲覧中')")
        try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('retained-phone-tail') === true")
        XCTAssertEqual(UIPasteboard.general.string, "explicit-user-copy")
        _ = try await webview.evaluateJavaScript("document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true})); document.querySelector('.xterm-helper-textarea').dispatchEvent(new InputEvent('input',{data:'phone-input',bubbles:true}))")
        let rejected = try await webview.callAsyncJavaScript("return (await window.webkit.messageHandlers.monica.postMessage({operation:'terminal-input',id:crypto.randomUUID()})).state", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(rejected, "unavailable")
        let before = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
        XCTAssertEqual(before["writes"] as? Int, 0)
        XCTAssertEqual(before["connections"] as? Int, 2)
        _ = try await control.read(.terminalSessions)
        try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('live-phone-output') === true")
        _ = try await control.read(.agentSessions)
        try await until("document.querySelector('.xterm-accessibility-tree')?.children.length === 31")
        _ = try await webview.evaluateJavaScript("document.querySelectorAll('article button')[1].click()")
        try await until("document.body.textContent.includes('閲覧中')")
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('live-phone-output') === true && document.body.textContent.includes('閲覧中')")
        try await until("document.querySelector('.xterm-accessibility-tree')?.children.length === 31")
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let foreground = try await webview.evaluateJavaScript("getComputedStyle(document.querySelector('.xterm-rows')).color") as? String
        XCTAssertEqual(foreground, "rgb(255, 255, 255)", "The bundled CSP must allow xterm's generated renderer styles, not black text on black")
        let image = try await webview.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image)
        attachment.name = "Read-only phone xterm at the applied Mac grid"
        attachment.lifetime = .keepAlways
        add(attachment)
        _ = try await webview.evaluateJavaScript("document.querySelector('[aria-label=\"Terminal Sessionの閲覧\"] button').click()")
        try await until("document.querySelector('.xterm') === null")
        var after: [String: Any] = [:]
        for _ in 0..<100 {
            after = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
            if after["connections"] as? Int == 1 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(after["connections"] as? Int, 1)
        XCTAssertEqual(after["writes"] as? Int, 0)
        XCTAssertEqual(after["lifecycle"] as? Int, 0)
        let sessions = try XCTUnwrap(after["sessions"] as? [[String: Any]])
        XCTAssertTrue(sessions.allSatisfy { $0["running"] as? Bool == true })
        XCTAssertEqual(sessions.first?["rows"] as? Int, 31)
        XCTAssertEqual(sessions.first?["cols"] as? Int, 97)
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        try await until("document.body.textContent.includes('閲覧中')")
        _ = try await webview.evaluateJavaScript("""
            window.recoveryOperations = [];
            const recoveryHandler = window.webkit.messageHandlers.monica;
            const recoveryOriginal = recoveryHandler.postMessage.bind(recoveryHandler);
            recoveryHandler.postMessage = message => {
                window.recoveryOperations.push({operation:message.operation,tabId:message.tabId,terminalSessionId:message.terminalSessionId});
                return recoveryOriginal(message);
            };
            null;
            """)
        for _ in 0..<3 {
            controller.bridge.suspend()
            try await until("document.body.textContent.includes('背景では表示接続を停止')")
            for _ in 0..<100 {
                after = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
                if after["connections"] as? Int == 1 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertEqual(after["connections"] as? Int, 1)
            controller.bridge.resume()
            try await until("document.querySelectorAll('article').length === 12 && document.body.textContent.includes('閲覧中')")
            try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('live-phone-output') === true")
            try await until("document.querySelector('.xterm-accessibility-tree')?.children.length === 31")
            let recovered = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
            XCTAssertEqual(recovered["connections"] as? Int, 2)
            XCTAssertEqual(recovered["writes"] as? Int, 0)
            XCTAssertEqual(recovered["lifecycle"] as? Int, 0)
        }
        let operations = try await webview.evaluateJavaScript("window.recoveryOperations") as! [[String: Any]]
        let opens = operations.filter { $0["operation"] as? String == "terminal-open" }
        XCTAssertEqual(opens.count, 3)
        let target = try XCTUnwrap(after["target"] as? [String: String])
        XCTAssertTrue(opens.allSatisfy { $0["tabId"] as? String == target["tabId"] && $0["terminalSessionId"] as? String == target["terminalSessionId"] })
        for index in operations.indices where operations[index]["operation"] as? String == "terminal-open" {
            let preceding = operations[..<index].compactMap { $0["operation"] as? String }
            XCTAssertTrue(preceding.contains("subscribe"))
            XCTAssertTrue(preceding.contains("layout/get"))
        }
        _ = try await webview.evaluateJavaScript("window.savedAnimationFrame = window.requestAnimationFrame; window.heldFrames = []; window.requestAnimationFrame = callback => { window.heldFrames.push(callback); return 0 }; void 0")
        _ = try await control.read(.terminalSessions)
        for _ in 0..<400 {
            after = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
            if after["connections"] as? Int == 1 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(after["connections"] as? Int, 1, "A stopped phone draw must release only its dedicated attachment")
        XCTAssertEqual(after["writes"] as? Int, 0)
        XCTAssertEqual(after["lifecycle"] as? Int, 0)
        _ = try await webview.evaluateJavaScript("window.requestAnimationFrame = window.savedAnimationFrame; for (const callback of window.heldFrames) requestAnimationFrame(callback); void 0")
    }

    @MainActor
    func testRemoteViewRecoversAfterRealLedgerListenerRestartWithoutReplayingInput() async throws {
        let all = try fixtures()
        let store = CredentialStore()
        try store.save(registration(all["large"]!))
        defer { try? store.remove() }
        let control = RemoteHTTP(registration(all["reconnect-control"]!))
        defer { control.close() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        func until(_ expression: String) async throws {
            for _ in 0..<200 {
                if let value = try? await webview.evaluateJavaScript(expression) as? Bool, value { return }
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTFail("Never observed: \(expression)")
        }
        try await until("document.querySelectorAll('article').length === 12")
        _ = try await webview.evaluateJavaScript("""
            window.restartOpens = [];
            const restartHandler = window.webkit.messageHandlers.monica;
            const restartOriginal = restartHandler.postMessage.bind(restartHandler);
            restartHandler.postMessage = message => {
                if (message.operation === 'terminal-open') window.restartOpens.push({tabId:message.tabId,terminalSessionId:message.terminalSessionId});
                return restartOriginal(message);
            };
            document.querySelector('article button').click();
            null;
            """)
        try await until("document.body.textContent.includes('閲覧中')")
        let before = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
        _ = try await control.read(.terminalSessions)
        try await until("window.restartOpens.length === 2 && document.body.textContent.includes('閲覧中')")
        try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('retained-phone-tail') === true")
        let after = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
        XCTAssertEqual(after["connections"] as? Int, 2)
        XCTAssertEqual(after["creates"] as? Int, before["creates"] as? Int)
        XCTAssertEqual(after["writes"] as? Int, before["writes"] as? Int)
        XCTAssertEqual(after["lifecycle"] as? Int, before["lifecycle"] as? Int)
        let opens = try await webview.evaluateJavaScript("window.restartOpens") as! [[String: String]]
        XCTAssertEqual(opens, Array(repeating: try XCTUnwrap(after["target"] as? [String: String]), count: 2))
    }

    @MainActor
    func testZBasicSharedInputIsAcceptedOnceAndMacParseStallDisablesIt() async throws {
        let all = try fixtures()
        let store = CredentialStore()
        try store.save(registration(all["large"]!))
        defer { try? store.remove() }
        let control = RemoteHTTP(registration(all["input-control"]!))
        defer { control.close() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        func until(_ expression: String) async throws {
            for _ in 0..<100 {
                if let result = try? await webview.evaluateJavaScript(expression) as? Bool, result { return }
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTFail("Never observed: \(expression)")
        }
        try await until("document.querySelectorAll('article').length === 12")
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        try await until("document.body.textContent.includes('閲覧中')")
        let disabled = try await webview.evaluateJavaScript("document.querySelector('form button').disabled") as? Bool
        XCTAssertEqual(disabled, true)
        _ = try await control.read(.terminalSessions)
        try await until("document.querySelector('form button')?.disabled === false")
        _ = try await webview.evaluateJavaScript("const field = document.querySelector('form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'phone-basic-input'); field.dispatchEvent(new Event('input',{bubbles:true})); void 0")
        _ = try await webview.evaluateJavaScript("document.querySelector('form button').click()")
        try await until("document.body.textContent.includes('Macの中継が受理しました')")
        let accepted = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
        let writes = try XCTUnwrap(accepted["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?["data"] as? String, Data("phone-basic-input\r".utf8).base64EncodedString())
        try await until("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('shared-input-result') === true")
        _ = try await control.read(.agentSessions)
        try await until("document.querySelector('form button')?.disabled === true")
        let stopped = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
        XCTAssertEqual((stopped["writes"] as? [[String: Any]])?.count, 1, "Phone replay and live queries must never become input")
        let image = try await webview.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image)
        attachment.name = "Shared input accepted then disabled by Mac parse stall"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testZZPhoneComposerSyntheticCompositionKeysTextClipboardAndFixedGrid() async throws {
        let all = try fixtures()
        let store = CredentialStore()
        try store.save(registration(all["large"]!))
        let clipboard = UIPasteboard.general.items
        defer { try? store.remove(); UIPasteboard.general.items = clipboard }
        let control = RemoteHTTP(registration(all["input-control"]!))
        let touchControl = RemoteHTTP(registration(all["touch-control"]!))
        let macControl = RemoteHTTP(registration(all["terminal-control"]!))
        let reconnectControl = RemoteHTTP(registration(all["reconnect-control"]!))
        defer { control.close(); touchControl.close(); macControl.close(); reconnectControl.close() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        func until(_ expression: String) async throws {
            for _ in 0..<100 {
                if let result = try? await webview.evaluateJavaScript(expression) as? Bool, result { return }
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTFail("Never observed: \(expression)")
        }
        func js(_ source: String) async throws {
            _ = try await webview.callAsyncJavaScript(source + "; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", arguments: [:], in: nil, contentWorld: .page)
        }
        func writes(atLeast expected: Int = 0) async throws -> [String] {
            for _ in 0..<100 {
                let object = try JSONSerialization.jsonObject(with: await touchControl.read(.layout)) as! [String: Any]
                let received = (object["writes"] as! [[String: Any]]).map { $0["data"] as! String }
                if received.count >= expected { return received }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("Never received \(expected) actual PTY writes")
            return []
        }
        try await until("document.querySelectorAll('article').length === 12")
        _ = try await macControl.read(.agentSessions)
        _ = try await control.read(.terminalSessions)
        try await js("document.querySelector('article button').click()")
        try await until("document.querySelector('form button')?.disabled === false")
        try await until("document.querySelector('.xterm-accessibility-tree')?.children.length === 31")
        let beforeViewing = try JSONSerialization.jsonObject(with: await touchControl.read(.layout)) as! [String: Any]
        let baseline = (beforeViewing["writes"] as! [[String: Any]]).count
        UIPasteboard.general.string = "reconnect-preview😀"
        try await js("document.querySelector('[data-paste]').click()")
        try await until("document.querySelector('[data-confirm-paste]') !== null")
        try await js("""
            window.combinedOldScreen = document.querySelector('.xterm-screen');
            const draft = document.querySelector('form input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(draft,'下書き😀');
            draft.dispatchEvent(new Event('input',{bubbles:true}));
            draft.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
            document.querySelector('[data-zoom-in]').click();
            """)
        _ = try await reconnectControl.read(.terminalSessions)
        try await until("document.querySelector('.xterm-screen') !== combinedOldScreen && document.querySelector('.terminal-state').textContent.includes('閲覧中')")
        _ = try await control.read(.terminalSessions)
        try await until("document.querySelector('.terminal-state').textContent.includes('Macと共有入力')")
        let preservedTargetState = try await webview.evaluateJavaScript("document.querySelector('form input').value === '下書き😀' && document.querySelector('form button').disabled && document.querySelector('.terminal-paste textarea').value === 'reconnect-preview😀' && getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '16px' && document.querySelectorAll('.xterm').length === 1") as? Bool
        XCTAssertEqual(preservedTargetState, true, "Fresh replay preserves the selected target's draft, composition and explicit preview, not an old renderer")
        XCTAssertEqual(UIPasteboard.general.string, "reconnect-preview😀", "Fresh renderer replay must reinstall the OSC clipboard rejection")
        try await js("""
            document.querySelector('form input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
            document.querySelector('.terminal-paste button:last-of-type').click();
            """)
        _ = try await webview.evaluateJavaScript("""
            window.combinedRAF = window.requestAnimationFrame;
            window.combinedFrames = [];
            window.combinedWriteFrames = 0;
            window.combinedCaptureDraw = false;
            window.requestAnimationFrame = callback => {
                if (combinedCaptureDraw) {
                    combinedFrames.push(callback);
                    return 0;
                }
                const source = callback.toString();
                if (source.includes('scrollTop') && source.includes('clientHeight')) {
                    combinedWriteFrames++;
                    return combinedRAF(timestamp => {
                        combinedCaptureDraw = true;
                        callback(timestamp);
                        combinedCaptureDraw = false;
                    });
                }
                return combinedRAF(callback);
            };
            null;
            """)
        let pendingDrawOutput = try JSONSerialization.jsonObject(with: await touchControl.read(.terminalSessions)) as! [String: Any]
        let pendingDrawMarker = "phone-normal-end-\(pendingDrawOutput["normalOutput"] as! Int)"
        try await until("combinedWriteFrames === 1 && combinedFrames.length === 1 && combinedFrames[0].toString().includes('scrollTop') && document.querySelector('.xterm-accessibility-tree').textContent.includes('\(pendingDrawMarker)')")
        controller.bridge.suspend()
        try await until("document.body.textContent.includes('背景では表示接続を停止')")
        _ = try await webview.evaluateJavaScript("window.requestAnimationFrame = combinedRAF; window.combinedOldScreen = document.querySelector('.xterm-screen'); null")
        controller.bridge.resume()
        try await until("document.querySelector('.xterm-screen') !== combinedOldScreen && document.querySelector('form button')?.disabled === false")
        try await until("document.querySelector('.xterm-accessibility-tree').lastElementChild.textContent.includes('\(pendingDrawMarker)')")
        try await js("document.querySelector('.terminal-viewport').style.flex = '0 0 120px'")
        let differentFollowTarget = try await webview.evaluateJavaScript("document.querySelector('.xterm').clientHeight - document.querySelector('.terminal-viewport').clientHeight > 0") as? Bool
        XCTAssertEqual(differentFollowTarget, true, "The fresh renderer's cursor is on its last row and its follow target must differ from zero")
        try await js("""
            const viewport = document.querySelector('.terminal-viewport');
            window.followTargetBeforeOldFrame = document.querySelector('.xterm').clientHeight - viewport.clientHeight;
            viewport.scrollTop = 0;
            window.positionBeforeOldFrame = viewport.scrollTop;
            window.requestAnimationFrame = callback => { callback(); return 0 };
            for (const callback of combinedFrames) callback();
            window.requestAnimationFrame = combinedRAF;
            """)
        let oldCallbackIsolated = try await webview.evaluateJavaScript("combinedWriteFrames === 1 && combinedFrames.length === 1 && followTargetBeforeOldFrame > positionBeforeOldFrame && positionBeforeOldFrame === 0 && document.querySelector('.terminal-viewport').scrollTop === positionBeforeOldFrame && document.querySelectorAll('.xterm').length === 1") as? Bool
        XCTAssertEqual(oldCallbackIsolated, true, "The exact old write draw completion cannot move the fresh renderer to its different nonzero follow target")
        try await js("document.querySelector('.terminal-viewport').style.flex = ''")
        let recoveredAudit = try JSONSerialization.jsonObject(with: await touchControl.read(.layout)) as! [String: Any]
        XCTAssertEqual((recoveredAudit["writes"] as! [[String: Any]]).count, baseline, "Restart, replay, foreground and old callbacks never replay input, after a later actual Create")
        XCTAssertEqual(recoveredAudit["resizes"] as? Int, beforeViewing["resizes"] as? Int)
        // These are synthetic composition events, not a Japanese OS keyboard acceptance test.
        try await js("""
            window.field = document.querySelector('form input');
            window.setDraft = text => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,text); field.dispatchEvent(new Event('input',{bubbles:true})) };
            field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
            setDraft('にほん');
            field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
            document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
            """)
        let compositionWrites = try await writes().count
        XCTAssertEqual(compositionWrites, baseline)
        try await js("""
            setDraft('日本😀');
            field.dispatchEvent(new CompositionEvent('compositionend',{data:'日本😀',bubbles:true}));
            field.dispatchEvent(new InputEvent('input',{data:'日本😀',inputType:'insertCompositionText',bubbles:true}));
            """)
        let committedWrites = try await writes().count
        XCTAssertEqual(committedWrites, baseline)
        try await js("""
            field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
            setDraft('取消前');
            setDraft('');
            field.dispatchEvent(new CompositionEvent('compositionend',{data:'',bubbles:true}));
            setDraft('日本😀x');
            field.dispatchEvent(new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true}));
            setDraft('日本😀');
            """)
        let cancelledWrites = try await writes().count
        XCTAssertEqual(cancelledWrites, baseline, "Composition cancellation and draft deletion stay local")
        try await js("""
            const handler = window.webkit.messageHandlers.monica;
            const original = handler.postMessage.bind(handler);
            window.holdPhoneInput = true;
            handler.postMessage = message => {
                if (message.operation === 'terminal-input' && window.holdPhoneInput) {
                    window.holdPhoneInput = false;
                    return new Promise(resolve => { window.releasePhoneInput = () => original(message).then(resolve) });
                }
                return original(message);
            };
            document.querySelector('form button').click();
            """)
        let pendingFeedback = try await webview.evaluateJavaScript("document.body.textContent.includes('送信中（受理確認前）') && document.querySelector('[aria-label=\"Esc\"]').disabled") as? Bool
        XCTAssertEqual(pendingFeedback, true)
        let heldWrites = try await writes().count
        XCTAssertEqual(heldWrites, baseline, "Immediate feedback is not an acceptance ACK")
        try await js("releasePhoneInput()")
        try await until("document.body.textContent.includes('Macの中継が受理しました')")
        var sent = try await writes(atLeast: baseline + 1)
        XCTAssertEqual(sent.count, baseline + 1)
        XCTAssertEqual(sent.last, Data("日本😀\r".utf8).base64EncodedString())
        for (name, bytes) in [("Esc", "\u{1b}"), ("Tab", "\t"), ("上矢印", "\u{1b}[A"), ("左矢印", "\u{1b}[D"), ("下矢印", "\u{1b}[B"), ("右矢印", "\u{1b}[C"), ("削除", "\u{7f}")] {
            try await js("document.querySelector('[aria-label=\"\(name)\"]').click()")
            try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
            let expectedWrites = sent.count + 1
            sent = try await writes(atLeast: expectedWrites)
            XCTAssertEqual(sent.count, expectedWrites, "Only the explicit auxiliary key may write")
            XCTAssertEqual(sent.last, Data(bytes.utf8).base64EncodedString(), name)
        }
        try await js("document.querySelector('[aria-label=\"Ctrl\"]').click(); setDraft('c'); document.querySelector('[data-send-text]').click()")
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
        sent = try await writes(atLeast: sent.count + 1)
        XCTAssertEqual(sent.last, Data([3]).base64EncodedString())
        try await js("document.querySelector('[aria-label=\"Ctrl\"]').click(); setDraft('d'); document.querySelector('form button').click()")
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
        sent = try await writes(atLeast: sent.count + 1)
        XCTAssertEqual(sent.last, Data([4]).base64EncodedString(), "Ctrl never appends an accidental Enter")
        UIPasteboard.general.url = URL(fileURLWithPath: "/not-a-terminal-file")
        try await js("document.querySelector('[data-paste]').click()")
        try await until("document.body.textContent.includes('貼り付けるテキストがありません')")
        let fileWrites = try await writes().count
        XCTAssertEqual(fileWrites, sent.count)
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        try await js("document.querySelector('[data-paste]').click()")
        let imageWrites = try await writes().count
        XCTAssertEqual(imageWrites, sent.count)
        let imagePreview = try await webview.evaluateJavaScript("document.querySelector('[data-confirm-paste]') === null") as? Bool
        XCTAssertEqual(imagePreview, true, "Image paste never becomes terminal text")
        UIPasteboard.general.string = "貼り付け😀\ntext"
        try await js("document.querySelector('[data-paste]').click()")
        try await until("document.querySelector('[data-confirm-paste]') !== null")
        let readWrites = try await writes().count
        XCTAssertEqual(readWrites, sent.count, "Reading clipboard must not send it")
        try await js("document.querySelector('[data-confirm-paste]').click()")
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
        sent = try await writes(atLeast: sent.count + 1)
        XCTAssertEqual(sent.last, Data("貼り付け😀\ntext".utf8).base64EncodedString())
        UIPasteboard.general.string = String(repeating: "あ", count: 87382)
        try await js("document.querySelector('[data-paste]').click()")
        try await until("document.body.textContent.includes('256KiB')")
        let oversizedWrites = try await writes().count
        XCTAssertEqual(oversizedWrites, sent.count)
        try await js("document.querySelector('.terminal-viewport').scrollTop = 100000; document.querySelector('.terminal-viewport').dispatchEvent(new Event('scroll'))")
        let normal1 = try JSONSerialization.jsonObject(with: await touchControl.read(.terminalSessions)) as! [String: Any]
        let marker1 = try XCTUnwrap(normal1["normalOutput"] as? Int)
        try await until("document.querySelector('.xterm-accessibility-tree').textContent.includes('phone-normal-end-\(marker1)')")
        let tailVisible = try await webview.evaluateJavaScript("""
            (() => {
                const row = [...document.querySelectorAll('.xterm-rows > div')].find(element => element.textContent.includes('phone-normal-end'));
                if (!row) return false;
                const line = row.getBoundingClientRect();
                const viewport = document.querySelector('.terminal-viewport').getBoundingClientRect();
                return line.top >= viewport.top && line.bottom <= viewport.bottom + 1;
            })()
            """) as? Bool
        XCTAssertEqual(tailVisible, true, "Normal output follows its tail until the user pans away")
        try await js("""
            window.outputViewport = document.querySelector('.terminal-viewport');
            outputViewport.scrollLeft = 90;
            outputViewport.scrollTop = 1;
            """)
        let readingPosition = try await webview.evaluateJavaScript("outputViewport.scrollTop") as? Double
        let normal2 = try JSONSerialization.jsonObject(with: await touchControl.read(.terminalSessions)) as! [String: Any]
        let marker2 = try XCTUnwrap(normal2["normalOutput"] as? Int)
        try await until("document.querySelector('.xterm-accessibility-tree').textContent.includes('phone-normal-end-\(marker2)')")
        let afterOutputPosition = try await webview.evaluateJavaScript("outputViewport.scrollTop") as? Double
        XCTAssertEqual(readingPosition, afterOutputPosition, "New output must not steal the user's reading position")
        try await js("""
            const terminal = document.querySelector('.xterm');
            terminal.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,bubbles:true,cancelable:true}));
            terminal.dispatchEvent(new MouseEvent('mousedown',{clientX:30,clientY:200,bubbles:true,cancelable:true}));
            terminal.dispatchEvent(new MouseEvent('mouseup',{clientX:30,clientY:200,bubbles:true,cancelable:true}));
            """)
        let panned = try await webview.evaluateJavaScript("outputViewport.scrollLeft > 0 && outputViewport.scrollTop > 0") as? Bool
        XCTAssertEqual(panned, true, "The Mac grid must remain pannable on the phone")
        try await js("""
            window.touchTarget = document.querySelector('.xterm-screen');
            window.xtermGestures = 0;
            touchTarget.addEventListener('-xterm-gesturechange', () => xtermGestures++);
            window.previousTouches = [];
            window.touch = (type, points) => {
                const touches = points.map(([identifier, clientX, clientY]) => new Touch({identifier, target:touchTarget, clientX, clientY, pageX:clientX, pageY:clientY}));
                const changedTouches = type === 'touchend' || type === 'touchcancel' ? previousTouches : touches;
                touchTarget.dispatchEvent(new TouchEvent(type, {bubbles:true, cancelable:true, touches, targetTouches:touches, changedTouches}));
                previousTouches = touches;
            };
            window.pan = (dx, dy) => {
                touch('touchstart', [[1,200,200]]);
                touch('touchmove', [[1,200+dx,200+dy]]);
                touch('touchend', []);
            };
            window.historyBefore = document.querySelector('.xterm-rows').textContent;
            pan(-100, 180);
            """)
        let normalTouch = try await webview.evaluateJavaScript("outputViewport.scrollLeft >= 190 && document.querySelector('.xterm-rows').textContent !== historyBefore && xtermGestures === 0") as? Bool
        XCTAssertEqual(normalTouch, true, "Real WKWebView TouchEvents must pan horizontally and reveal normal history without xterm consuming them")
        try await js("pan(10000,100000)")
        try await until("document.querySelector('.xterm-rows').textContent.includes('phone-scroll-0 ')")
        try await js("""
            outputViewport.style.flex = 'none';
            outputViewport.style.height = '1000px';
            window.fittingHistory = document.querySelector('.xterm-rows').textContent;
            touch('touchstart', [[1,200,200]]);
            for (let y = 195; y >= 140; y -= 5) touch('touchmove', [[1,200,y]]);
            touch('touchend', []);
            """)
        let fittingHistory = try await webview.evaluateJavaScript("document.querySelector('.xterm-rows').textContent !== fittingHistory") as? Bool
        XCTAssertEqual(fittingHistory, true, "Small touch moves accumulate through history even when the entire Mac grid fits")
        try await js("outputViewport.style.flex = ''; outputViewport.style.height = ''; pan(-100000,-100000)")
        let normalEdges = try await webview.evaluateJavaScript("outputViewport.scrollLeft + outputViewport.clientWidth >= outputViewport.scrollWidth - 1 && outputViewport.scrollTop + outputViewport.clientHeight >= outputViewport.scrollHeight - 1") as? Bool
        XCTAssertEqual(normalEdges, true, "Normal fixed-grid bottom and right edge remain reachable after reading history")
        _ = try await touchControl.read(.agentSessions)
        try await until("document.querySelector('.xterm-accessibility-tree').textContent.includes('phone-tui-mouse')")
        _ = try await control.read(.terminalSessions)
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
        for (name, bytes) in [("上矢印", "\u{1b}OA"), ("下矢印", "\u{1b}OB"), ("左矢印", "\u{1b}OD"), ("右矢印", "\u{1b}OC")] {
            try await js("document.querySelector('[aria-label=\"\(name)\"]').click()")
            try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
            let expectedWrites = sent.count + 1
            sent = try await writes(atLeast: expectedWrites)
            XCTAssertEqual(sent.count, expectedWrites, "Only the explicit auxiliary key may write")
            XCTAssertEqual(sent.last, Data(bytes.utf8).base64EncodedString(), "DECCKM " + name)
        }
        try await js("pan(100000,100000)")
        let tuiTopLeft = try await webview.evaluateJavaScript("outputViewport.scrollLeft === 0 && outputViewport.scrollTop === 0") as? Bool
        XCTAssertEqual(tuiTopLeft, true)
        try await js("""
            touch('touchstart', [[1,200,200]]);
            touch('touchmove', [[1,160,160]]);
            touch('touchmove', [[1,180,180]]);
            touch('touchend', []);
            """)
        let reversed = try await webview.evaluateJavaScript("Math.abs(outputViewport.scrollLeft - 20) < 1 && Math.abs(outputViewport.scrollTop - 20) < 1") as? Bool
        XCTAssertEqual(reversed, true, "Pan follows each move 1:1 and reverses before release")
        try await js("""
            touch('touchstart', [[1,200,200]]);
            touch('touchcancel', []);
            touch('touchmove', [[1,100,100]]);
            touch('touchend', []);
            touch('touchstart', [[1,200,200]]);
            touch('touchstart', [[1,200,200],[2,220,220]]);
            touch('touchmove', [[1,100,100]]);
            touch('touchend', []);
            """)
        let cancelledPan = try await webview.evaluateJavaScript("Math.abs(outputViewport.scrollLeft - 20) < 1 && Math.abs(outputViewport.scrollTop - 20) < 1") as? Bool
        XCTAssertEqual(cancelledPan, true, "Cancellation and additional fingers abandon the reading pan")
        try await js("pan(-100000,-100000)")
        let tuiEdges = try await webview.evaluateJavaScript("outputViewport.scrollLeft + outputViewport.clientWidth >= outputViewport.scrollWidth - 1 && outputViewport.scrollTop + outputViewport.clientHeight >= outputViewport.scrollHeight - 1 && xtermGestures === 0") as? Bool
        XCTAssertEqual(tuiEdges, true, "Alternate-buffer mouse tracking cannot consume fixed-grid reading touches")
        try await js("""
            const terminal = document.querySelector('.xterm');
            terminal.dispatchEvent(new WheelEvent('wheel',{deltaY:200,bubbles:true,cancelable:true}));
            terminal.dispatchEvent(new MouseEvent('mousedown',{clientX:40,clientY:200,bubbles:true,cancelable:true}));
            terminal.dispatchEvent(new MouseEvent('mousemove',{clientX:80,clientY:250,bubbles:true,cancelable:true,buttons:1}));
            terminal.dispatchEvent(new MouseEvent('mouseup',{clientX:80,clientY:250,bubbles:true,cancelable:true}));
            document.querySelector('[aria-label="Esc"]').click();
            """)
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
        let gestureWrites = try await writes(atLeast: sent.count + 1)
        XCTAssertEqual(gestureWrites.count, sent.count + 1, "Normal/TUI viewing gestures must not generate terminal mouse or key bytes")
        XCTAssertEqual(gestureWrites.last, Data([27]).base64EncodedString())
        sent = gestureWrites
        let normal3 = try JSONSerialization.jsonObject(with: await touchControl.read(.terminalSessions)) as! [String: Any]
        let marker3 = try XCTUnwrap(normal3["normalOutput"] as? Int)
        try await until("document.querySelector('.xterm-accessibility-tree').textContent.includes('phone-normal-end-\(marker3)')")
        for (name, bytes) in [("上矢印", "\u{1b}[A"), ("下矢印", "\u{1b}[B"), ("左矢印", "\u{1b}[D"), ("右矢印", "\u{1b}[C")] {
            try await js("document.querySelector('[aria-label=\"\(name)\"]').click()")
            try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === false")
            let expectedWrites = sent.count + 1
            sent = try await writes(atLeast: expectedWrites)
            XCTAssertEqual(sent.count, expectedWrites, "Only the explicit auxiliary key may write")
            XCTAssertEqual(sent.last, Data(bytes.utf8).base64EncodedString(), "Reset DECCKM " + name)
        }
        try await js("document.querySelector('[data-select-output]').click()")
        try await until("document.querySelector('[data-output-text]') !== null")
        try await js("const output = document.querySelector('[data-output-text]'); output.setSelectionRange(0,8); document.querySelector('[data-copy-output]').click()")
        try await until("document.body.textContent.includes('コピーしました')")
        XCTAssertEqual(UIPasteboard.general.string?.count, 8)
        let beforeViewport = try JSONSerialization.jsonObject(with: await touchControl.read(.layout)) as! [String: Any]
        try await js("document.querySelector('[data-select-output]').click(); document.querySelector('[data-zoom-in]').click()")
        let gridBefore = try await webview.evaluateJavaScript("document.querySelector('.xterm-accessibility-tree').children.length") as? Int
        controller.view.frame.size = CGSize(width: 740, height: 360)
        controller.view.layoutIfNeeded()
        try await js("window.dispatchEvent(new Event('resize'))")
        let gridAfter = try await webview.evaluateJavaScript("document.querySelector('.xterm-accessibility-tree').children.length") as? Int
        XCTAssertEqual(gridBefore, gridAfter)
        let afterViewport = try JSONSerialization.jsonObject(with: await touchControl.read(.layout)) as! [String: Any]
        XCTAssertEqual(afterViewport["resizes"] as? Int, beforeViewport["resizes"] as? Int, "Viewing operations never resize the PTY")
        XCTAssertEqual(afterViewport["resizes"] as? Int, beforeViewing["resizes"] as? Int, "Normal/TUI gestures, selection and zoom leave the Mac grid unchanged after a later actual Create")
        XCTAssertEqual((afterViewport["writes"] as? [[String: Any]])?.count, sent.count)
        let controlsVisible = try await webview.evaluateJavaScript("""
            [...document.querySelectorAll('.terminal-state, .terminal-keys, #terminal-draft, form button')].every(element => {
                const rect = element.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= window.innerHeight;
            })
            """) as? Bool
        if UIFont.preferredFont(forTextStyle: .body).pointSize <= 17 {
            XCTAssertEqual(controlsVisible, true, "Connection status, keys and draft must fit a compact-height viewport")
        }
        let reachableControls = try await webview.callAsyncJavaScript("""
            for (const element of document.querySelectorAll('.terminal-state, .terminal-keys, #terminal-draft, form button')) {
                element.scrollIntoView({block:'nearest'});
                await new Promise(resolve => requestAnimationFrame(resolve));
                const rect = element.getBoundingClientRect();
                if (rect.bottom < 0 || rect.top >= window.innerHeight) return false;
            }
            return true;
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(reachableControls, true, "Larger text must keep every control reachable by scrolling")
        let image = try await webview.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image)
        attachment.name = "Phone input controls with fixed grid after viewport change"
        attachment.lifetime = .keepAlways
        add(attachment)
        try await js("setDraft('must-not-carry-to-another-terminal'); document.querySelectorAll('article button')[1].click()")
        let newDraft = try await webview.evaluateJavaScript("document.querySelector('#terminal-draft').value") as? String
        XCTAssertEqual(newDraft, "", "Draft and paste state belong to exactly one Terminal Session")
        try await js("window.disposedPosition = [outputViewport.scrollLeft, outputViewport.scrollTop]; pan(100,100)")
        let disposedPan = try await webview.evaluateJavaScript("outputViewport.scrollLeft === disposedPosition[0] && outputViewport.scrollTop === disposedPosition[1]") as? Bool
        XCTAssertEqual(disposedPan, true, "The disposed renderer must release its reading listeners")
        try await js("document.querySelector('article button').click()")
        try await until("document.querySelector('form button')?.disabled === false")
        _ = try await control.read(.agentSessions)
        try await until("document.querySelector('[aria-label=\"Esc\"]').disabled === true")
        try await js("document.querySelector('[aria-label=\"Esc\"]').click(); document.querySelector('[data-paste]').click()")
        let stoppedWrites = try await writes().count
        XCTAssertEqual(stoppedWrites, sent.count)
    }

    @MainActor
    func testZZZSimulatorSoftwareKeyboardKeepsWKWebViewAboveItWithoutPTYResize() async throws {
        let all = try fixtures()
        let store = CredentialStore()
        try store.save(registration(all["large"]!))
        defer { try? store.remove() }
        let control = RemoteHTTP(registration(all["input-control"]!))
        let audit = RemoteHTTP(registration(all["touch-control"]!))
        defer { control.close(); audit.close() }
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first(where: { $0.isKeyWindow }))
        (window.rootViewController as? WorkbenchController)?.bridge.suspend()
        window.rootViewController = controller
        defer { controller.bridge.suspend() }
        let webview = controller.webview!
        for _ in 0..<100 {
            if let count = try? await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int, count == 12 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        _ = try await control.read(.terminalSessions)
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        for _ in 0..<100 {
            if let ready = try? await webview.evaluateJavaScript("document.querySelector('form button')?.disabled === false") as? Bool, ready { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let before = try JSONSerialization.jsonObject(with: await audit.read(.layout)) as! [String: Any]
        let shown = expectation(forNotification: UIResponder.keyboardDidShowNotification, object: nil)
        _ = try await webview.evaluateJavaScript("document.querySelector('#terminal-draft').focus()")
        await fulfillment(of: [shown], timeout: 3)
        controller.view.layoutIfNeeded()
        let keyboardTop = controller.view.keyboardLayoutGuide.layoutFrame.minY
        XCTAssertLessThan(keyboardTop, controller.view.bounds.height - 100, "A real Simulator software keyboard must be shown, not a synthetic viewport event")
        XCTAssertLessThanOrEqual(webview.frame.maxY, keyboardTop + 0.5)
        _ = try await webview.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let focusedDraftVisible = try await webview.evaluateJavaScript("""
            (() => {
                const rect = document.querySelector('#terminal-draft').getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= window.innerHeight;
            })()
            """) as? Bool
        XCTAssertEqual(focusedDraftVisible, true, "The focused draft must actually be visible above the software keyboard, including accessibility text sizes")
        let image = try await webview.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image)
        attachment.name = "Actual WKWebView above the Simulator software keyboard"
        attachment.lifetime = .keepAlways
        add(attachment)
        let hidden = expectation(forNotification: UIResponder.keyboardDidHideNotification, object: nil)
        _ = try await webview.evaluateJavaScript("document.querySelector('#terminal-draft').blur()")
        await fulfillment(of: [hidden], timeout: 3)
        let after = try JSONSerialization.jsonObject(with: await audit.read(.layout)) as! [String: Any]
        XCTAssertEqual(before["resizes"] as? Int, after["resizes"] as? Int)
        XCTAssertEqual((before["writes"] as? [[String: Any]])?.count, (after["writes"] as? [[String: Any]])?.count)
        XCTAssertGreaterThan(webview.frame.maxY, keyboardTop)
    }

}
