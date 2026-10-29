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
        XCTAssertTrue(status?.contains("承認が必要") == true)
        let count = try await webview.evaluateJavaScript("document.querySelectorAll('article').length") as? Int
        XCTAssertEqual(count, 0)
        relaunched.bridge.suspend()
        let revokedRelaunch = WorkbenchController()
        revokedRelaunch.loadViewIfNeeded()
        window.rootViewController = revokedRelaunch
        defer { revokedRelaunch.bridge.suspend() }
        for _ in 0..<100 {
            if let text = try? await revokedRelaunch.webview!.evaluateJavaScript("document.querySelector('header [role=status]')?.textContent") as? String, text.contains("承認が必要") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let revokedExpired = try await revokedRelaunch.webview!.evaluateJavaScript("document.body.textContent.includes('登録の期限が切れました')") as? Bool
        XCTAssertEqual(revokedExpired, false)
        let revokedStatus = try await revokedRelaunch.webview!.evaluateJavaScript("document.querySelector('header [role=status]').textContent") as? String
        XCTAssertTrue(revokedStatus?.contains("承認が必要") == true)
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
        controller.bridge.suspend()
        try await until("document.querySelector('.xterm') === null")
        for _ in 0..<100 {
            after = try JSONSerialization.jsonObject(with: await control.read(.layout)) as! [String: Any]
            if after["connections"] as? Int == 1 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(after["connections"] as? Int, 1)
        controller.bridge.resume()
        try await until("document.querySelectorAll('article').length === 12")
        let stillClosed = try await webview.evaluateJavaScript("document.querySelector('.xterm') === null") as? Bool
        XCTAssertEqual(stillClosed, true)
        _ = try await webview.evaluateJavaScript("document.querySelector('article button').click()")
        try await until("document.body.textContent.includes('閲覧中')")
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

}
