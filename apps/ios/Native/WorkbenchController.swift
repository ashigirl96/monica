import UIKit
import WebKit
@preconcurrency import AVFoundation

@MainActor
final class WorkbenchController: UIViewController, WKNavigationDelegate {
    let entry = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "dist")!
    lazy var bridge = NativeBridge(entry: entry)
    private(set) var webview: WKWebView?
    private var scanning = false

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "monica")
        let webview = WKWebView(frame: .zero, configuration: configuration)
        bridge.controller = self
        webview.navigationDelegate = self
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        self.webview = webview
        view = webview
        webview.loadFileURL(entry, allowingReadAccessTo: entry.deletingLastPathComponent())
        NotificationCenter.default.addObserver(self, selector: #selector(suspend), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func suspend() { bridge.suspend() }
    @objc private func resume() { bridge.resume() }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url == entry ? .allow : .cancel)
    }

    func scan() async throws -> String {
        guard !scanning else { throw RemoteFailure.unavailable }
        scanning = true
        defer { scanning = false }
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            let alert = UIAlertController(title: "カメラを利用できません", message: "設定でカメラを許可してください。SimulatorにはQR用カメラがありません。", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "閉じる", style: .cancel))
            present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
            throw RemoteFailure.unavailable
        }
        return try await withCheckedThrowingContinuation { continuation in
            let scanner = QRScanner { [weak self] result in
                self?.dismiss(animated: !UIAccessibility.isReduceMotionEnabled)
                continuation.resume(with: result)
            }
            present(UINavigationController(rootViewController: scanner), animated: !UIAccessibility.isReduceMotionEnabled)
        }
    }
}

@MainActor
final class QRScanner: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate, UIAdaptivePresentationControllerDelegate {
    private let session = AVCaptureSession()
    private var completion: ((Result<String, Error>) -> Void)?
    private var preview: AVCaptureVideoPreviewLayer?

    init(completion: @escaping (Result<String, Error>) -> Void) { self.completion = completion; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Macの登録QR"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "キャンセル", style: .plain, target: self, action: #selector(cancel))
        isModalInPresentation = true
        navigationController?.isModalInPresentation = true
        view.backgroundColor = .systemBackground
        do {
            guard let camera = AVCaptureDevice.default(for: .video) else { throw RemoteFailure.unavailable }
            let input = try AVCaptureDeviceInput(device: camera)
            let output = AVCaptureMetadataOutput()
            guard session.canAddInput(input), session.canAddOutput(output) else { throw RemoteFailure.unavailable }
            session.addInput(input)
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            view.layer.addSublayer(preview)
            self.preview = preview
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        } catch { finish(.failure(error)) }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    @objc private func cancel() { finish(.failure(RemoteFailure.unavailable)) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { cancel() }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        guard value.utf8.count <= 8192 else { finish(.failure(RemoteFailure.identityChanged)); return }
        finish(.success(value))
    }
    private func finish(_ result: Result<String, Error>) {
        guard let completion else { return }
        self.completion = nil
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        completion(result)
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = WorkbenchController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
