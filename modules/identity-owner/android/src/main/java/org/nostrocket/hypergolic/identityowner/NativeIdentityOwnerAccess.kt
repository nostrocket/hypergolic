package org.nostrocket.hypergolic.identityowner

/** Native modules verify the existing owner; this does not claim or replace it. */
object NativeIdentityOwnerAccess {
  @JvmStatic fun owns(context: Any): Boolean = IdentityOwnerClaim.contexts.owns(context)
}
