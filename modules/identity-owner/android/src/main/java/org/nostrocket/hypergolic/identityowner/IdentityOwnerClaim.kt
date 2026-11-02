package org.nostrocket.hypergolic.identityowner

/** One trusted main-runtime identity bootstrap per OS process. No reset or reclaim. */
internal object IdentityOwnerClaim {
  val contexts = IdentityOwnerContextRegistry()
}
