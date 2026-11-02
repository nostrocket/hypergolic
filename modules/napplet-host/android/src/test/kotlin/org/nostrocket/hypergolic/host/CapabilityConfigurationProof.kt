package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

object CapabilityConfigurationProof {
  private var assertions = 0
  private fun checkProof(value: Boolean) {
    assertions++
    check(value) { "Capability configuration proof assertion $assertions failed" }
  }
  private fun raw(fixture: String, domains: List<String>, extra: String? = null): String {
    val value = JSONObject()
      .put("sessionId", "session-A").put("epoch", 1)
      .put("user", "1".repeat(64)).put("publisher", "2".repeat(64))
      .put("appId", "test.napplet").put("version", "3".repeat(64))
      .put("instanceId", "instance-A").put("fixture", fixture)
      .put("domains", JSONArray(domains))
    if (extra != null) value.put(extra, true)
    return value.toString()
  }
  private fun denied(raw: String, published: Boolean = true) {
    checkProof(runCatching { CapabilityConfiguration(raw, "view-generation", published) }.isFailure)
  }

  @JvmStatic fun main(args: Array<String>) {
    val old = CapabilityConfiguration(raw("ux-lab", listOf("theme")), "old-generation")
    checkProof(old.fixture == "ux-lab" && old.grantedDomains == listOf("theme"))
    checkProof(old.snapshot.contains("old-generation"))
    checkProof(CapabilityConfiguration(raw("feed-lab", listOf("identity", "relay", "theme")), "feed-generation").grantedDomains.size == 3)
    checkProof(CapabilityConfiguration(raw("feed-lab", listOf("identity", "outbox", "relay", "theme")), "outbox-generation").grantedDomains.size == 4)
    checkProof(CapabilityConfiguration(raw("nap-support", listOf("link", "theme")), "support-generation").grantedDomains == listOf("link", "theme"))
    val archive = CapabilityConfiguration(raw("approval-lab-v1", listOf("identity", "relay", "theme")), "archive-generation")
    checkProof(archive.fixture == "approval-lab-v1" && archive.allowsRelay)
    checkProof(archive.grantedDomains == listOf("identity", "relay", "theme"))
    denied(raw("approval-lab-v1", listOf("identity", "theme")))
    denied(raw("approval-lab-v1", listOf("identity", "relay", "theme", "storage")))
    denied(raw("approval-lab-v1", listOf("identity", "relay", "theme", "relay")))
    val archive2 = CapabilityConfiguration(raw("approval-lab-v2", listOf("identity", "relay", "theme")), "archive2-generation")
    checkProof(archive2.fixture == "approval-lab-v2" && archive2.allowsRelay)
    checkProof(archive2.grantedDomains == listOf("identity", "relay", "theme"))
    denied(raw("approval-lab-v2", listOf("identity", "theme")))
    denied(raw("approval-lab-v2", listOf("identity", "relay", "theme", "storage")))
    denied(raw("approval-lab-v2", listOf("identity", "relay", "theme", "relay")))
    val archivedFeed = CapabilityConfiguration(raw("feed-lab-v1", listOf("identity", "outbox", "relay", "theme")), "feed-archive-generation")
    checkProof(archivedFeed.fixture == "feed-lab-v1" && archivedFeed.grantedDomains.size == 4)
    denied(raw("feed-lab-v1", listOf("identity", "relay", "theme")))
    denied(raw("feed-lab-v1", listOf("identity", "outbox", "relay", "theme", "storage")))
    denied(raw("feed-lab-v1", listOf("identity", "outbox", "relay", "theme", "relay")))
    denied(raw("feed-lab-v2", listOf("identity", "outbox", "relay", "theme")))
    val archive3 = CapabilityConfiguration(raw("approval-lab-v3", listOf("identity", "relay", "theme")), "archive3-generation")
    checkProof(archive3.fixture == "approval-lab-v3" && archive3.allowsRelay)
    checkProof(archive3.grantedDomains == listOf("identity", "relay", "theme"))
    denied(raw("approval-lab-v3", listOf("identity", "theme")))
    denied(raw("approval-lab-v3", listOf("identity", "relay", "theme", "storage")))
    denied(raw("approval-lab-v3", listOf("identity", "relay", "theme", "relay")))
    denied(raw("approval-lab-v4", listOf("identity", "relay", "theme")))
    denied(raw("nap-support", listOf("link", "theme", "fs")))
    denied(raw("feed-lab", listOf("identity", "outbox", "theme")))
    val outbox = CapabilityConfiguration(raw("published", listOf("outbox", "relay")), "outbox-generation", true)
    checkProof(outbox.grantedDomains == listOf("outbox", "relay") && outbox.allowsRelay)
    checkProof(outbox.snapshot.contains("outbox-generation"))
    val noRelay = CapabilityConfiguration(raw("published", listOf("outbox")), "outbox-only", true)
    checkProof(!noRelay.allowsRelay && noRelay.grantedDomains == listOf("outbox"))
    denied(raw("published", listOf("outbox", "outbox", "relay")))
    denied(raw("published", listOf("outbox", "relay")), published = false)
    val published = CapabilityConfiguration(raw("published", listOf("identity", "storage", "theme", "relay")),
      "published-generation", allowPublished = true)
    checkProof(published.fixture == "published" && published.grantedDomains.size == 4)
    checkProof(published.grantedDomains == listOf("identity", "relay", "storage", "theme"))
    checkProof(published.sessionId == "session-A" && published.publisher == "2".repeat(64))
    checkProof(published.appId == "test.napplet" && published.version == "3".repeat(64))
    checkProof(published.allowsRelay && published.snapshot.contains("published-generation"))
    checkProof(CapabilityConfiguration(raw("published", emptyList()), "empty-domains", true).grantedDomains.isEmpty())
    checkProof(CapabilityConfiguration(raw("published", listOf("theme")), "theme-only", true).grantedDomains == listOf("theme"))

    val uploads = CapabilityConfiguration(raw("published", listOf("resource", "upload")), "upload-generation", true)
    checkProof(uploads.grantedDomains == listOf("resource", "upload") && uploads.allowsUpload)
    checkProof(CapabilityConfiguration(raw("published", listOf("identity", "storage", "theme", "relay", "resource", "upload")), "all-domains", true).grantedDomains.size == 6)
    denied(raw("published", listOf("upload", "upload")))
    denied(raw("published", listOf("theme")), published = false)
    denied(raw("published", listOf("theme", "theme")))
    denied(raw("published", listOf("unknown")))
    denied(raw("published", listOf("identity", "storage", "theme", "relay", "identity")))
    denied(raw("ux-lab", listOf("identity", "theme")))
    denied(raw("published", listOf("theme"), extra = "untrusted"))
    denied("{" + " ".repeat(8200) + "}")
    println("{\"status\":\"passed\",\"assertions\":$assertions}")
  }
}
