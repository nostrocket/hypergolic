package org.nostrocket.hypergolic.identityowner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Retired bridge. Native authentication and reveal controls are used by the native vault only. */
class IdentityActionsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HypergolicIdentityActions")
  }
}
