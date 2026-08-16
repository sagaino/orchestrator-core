import AppKit
import Foundation
import UserNotifications

private struct NotificationPayload {
    let identifier: String
    let title: String
    let subtitle: String
    let message: String
}

private let registerOnly = CommandLine.arguments.contains("--register-only")

private func argumentValue(_ name: String, arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

private func parsePayload() -> NotificationPayload? {
    let arguments = CommandLine.arguments
    guard
        let identifier = argumentValue("--identifier", arguments: arguments),
        let title = argumentValue("--title", arguments: arguments),
        let message = argumentValue("--message", arguments: arguments)
    else {
        return nil
    }
    return NotificationPayload(
        identifier: identifier,
        title: title,
        subtitle: argumentValue("--subtitle", arguments: arguments) ?? "Personal AI Orchestrator",
        message: message
    )
}

private func printResult(status: String, reason: String? = nil) {
    var result: [String: String] = ["status": status]
    if let reason {
        result["reason"] = reason
    }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
       let value = String(data: data, encoding: .utf8) {
        print(value)
        fflush(stdout)
    }
}

private final class NotificationAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let payload: NotificationPayload?

    init(payload: NotificationPayload?) {
        self.payload = payload
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error {
                        self.finish(status: "FAILED", reason: error.localizedDescription, exitCode: 2)
                    } else if granted {
                        self.continueAfterAuthorization(using: center)
                    } else {
                        self.finish(status: "DENIED", reason: "Notification permission was not granted.", exitCode: 3)
                    }
                }
            case .authorized, .provisional, .ephemeral:
                self.continueAfterAuthorization(using: center)
            case .denied:
                self.finish(status: "DENIED", reason: "Enable notifications for Personal AI Orchestrator in System Settings.", exitCode: 3)
            @unknown default:
                self.finish(status: "FAILED", reason: "Unknown notification authorization status.", exitCode: 2)
            }
        }
    }

    private func continueAfterAuthorization(using center: UNUserNotificationCenter) {
        if registerOnly {
            finish(status: "REGISTERED", exitCode: 0)
        } else {
            schedule(using: center)
        }
    }

    private func schedule(using center: UNUserNotificationCenter) {
        guard let payload else {
            finish(status: "FAILED", reason: "Notification payload is missing.", exitCode: 64)
            return
        }
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.subtitle = payload.subtitle
        content.body = payload.message
        content.sound = .default
        let request = UNNotificationRequest(identifier: payload.identifier, content: content, trigger: nil)
        center.add(request) { [weak self] error in
            guard let self else { return }
            if let error {
                self.finish(status: "FAILED", reason: error.localizedDescription, exitCode: 2)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    self.finish(status: "ACCEPTED", exitCode: 0)
                }
            }
        }
    }

    private func finish(status: String, reason: String? = nil, exitCode: Int32) {
        DispatchQueue.main.async {
            printResult(status: status, reason: reason)
            Foundation.exit(exitCode)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

private let payload = parsePayload()
if payload == nil && !registerOnly {
    printResult(status: "FAILED", reason: "Required notification arguments are missing.")
    Foundation.exit(64)
}

private let application = NSApplication.shared
private let delegate = NotificationAppDelegate(payload: payload)
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
