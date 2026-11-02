import Foundation
var cases = 0
func check(_ result: Bool) {
  cases += 1
  precondition(result, "Policy case \(cases)")
}
let key = "scope." + String(repeating: "a1", count: 32)
let service = NappletConfigPolicy.service
func accepts(_ key: String, _ service: String?, _ auth: Bool = false, _ prompt: String? = nil, _ accessibility: Int = 6, _ group: String? = nil) -> Bool {
  NappletConfigPolicy.allows(key: key, service: service, authenticated: auth, prompt: prompt, accessibility: accessibility, accessGroup: group)
}
check(accepts(key, service))
for candidate in ["inventory", "secret.a", "stage.a", "scope.", key + "a", String(key.dropFirst()), key.uppercased(), key + "\n", key.replacingOccurrences(of: "a", with: "g"), "scope." + String(repeating: "é", count: 64), " " + key] {
  check(!accepts(candidate, service))
}
for candidate: String? in ["app", "key_v1", "org.nostrocket.hypergolic.identity.v1", service + ":no-auth", service + ":auth", "", nil] {
  check(!accepts(key, candidate))
}
check(!accepts(key, service, true))
for prompt in ["", " ", "Confirm"] { check(!accepts(key, service, false, prompt)) }
for access in -1...8 where access != 6 { check(!accepts(key, service, false, nil, access)) }
for group in ["", "other.group"] { check(!accepts(key, service, false, nil, 6, group)) }
print("iOS owning native policy: \(cases) cases passed")
