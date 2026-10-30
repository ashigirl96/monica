import Foundation
import Security

struct CredentialStore {
    var account = "registered-mac"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.monica.remote", kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> Registration? {
        var query = query
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw RemoteFailure.unavailable }
        return try JSONDecoder().decode(Registration.self, from: data)
    }

    func save(_ registration: Registration) throws {
        let data = try JSONEncoder().encode(registration)
        let attributes: [String: Any] = [kSecValueData as String: data,
                                      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess
            else { throw RemoteFailure.unavailable }
        } else if status != errSecSuccess { throw RemoteFailure.unavailable }
    }

    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw RemoteFailure.unavailable }
    }

    func attributes() throws -> [String: Any] {
        var query = query
        query[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let attributes = result as? [String: Any] else { throw RemoteFailure.unavailable }
        return attributes
    }

    static func secret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw RemoteFailure.unavailable }
        return "monica-remote-v1." + bytes.map { String(format: "%02x", $0) }.joined()
    }
}
