package org.nostrocket.hypergolic.host

import android.content.Context
import android.graphics.Rect
import android.os.Build
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** Reserves only the visible shell handle's touch area from Android system Back. */
class ShellGestureRegionView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var handleActive = false

  fun setHandleActive(active: Boolean) {
    handleActive = active
    updateExclusion()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    updateExclusion()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateExclusion()
  }

  override fun onDetachedFromWindow() {
    if (Build.VERSION.SDK_INT >= 29) systemGestureExclusionRects = emptyList()
    super.onDetachedFromWindow()
  }

  private fun updateExclusion() {
    if (Build.VERSION.SDK_INT >= 29) {
      systemGestureExclusionRects = if (handleActive && isAttachedToWindow && width > 0 && height > 0) {
        listOf(Rect(0, 0, width, height))
      } else emptyList()
    }
  }
}
