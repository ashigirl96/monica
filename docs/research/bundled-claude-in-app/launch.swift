// usage: launch <app> [args...]
// Finder や Dock と同じく NSWorkspace で .app を起こす。`open` は呼んだ shell の env を app に渡すため、それを避ける。
import AppKit

let argv = CommandLine.arguments
let config = NSWorkspace.OpenConfiguration()
config.createsNewApplicationInstance = true
config.activates = false
config.arguments = Array(argv.dropFirst(2))
let done = DispatchSemaphore(value: 0)
var status: Int32 = 0
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: argv[1]), configuration: config) { app, error in
    if let error {
        FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
        status = 1
    } else {
        print(app?.processIdentifier ?? -1)
    }
    done.signal()
}
done.wait()
exit(status)
