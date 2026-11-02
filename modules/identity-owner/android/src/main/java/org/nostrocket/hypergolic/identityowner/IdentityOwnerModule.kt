package org.nostrocket.hypergolic.identityowner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class IdentityOwnerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HypergolicIdentityOwner")
    Function("claimIdentityOwner") {
      val onMainJavaScriptThread = runCatching { appContext.runtime.reactContext?.isOnJSQueueThread == true }.getOrDefault(false)
      IdentityOwnerClaim.contexts.claim(appContext, onMainJavaScriptThread)
    }
    OnDestroy { IdentityOwnerClaim.contexts.retireIfOwned(appContext) }
  }
}
