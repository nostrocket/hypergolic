package org.nostrocket.hypergolic.host

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.view.ViewTreeObserver
import android.view.WindowInsets
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** Measures IME overlap at the bottom of the actual dialog viewport, including on edge-to-edge windows. */
class KeyboardBoundaryView(context: Context, appContext: AppContext) : ExpoView(context, appContext),
  ViewTreeObserver.OnPreDrawListener {
  private val onOverlapChange by EventDispatcher()
  private val position = IntArray(2)
  private val visibleFrame = Rect()
  private var lastOverlap = 0

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(this)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(this)
    super.onDetachedFromWindow()
  }

  override fun onPreDraw(): Boolean {
    val root = rootView
    val keyboardTop = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val ime = rootWindowInsets?.getInsets(WindowInsets.Type.ime())?.bottom ?: 0
      root.getLocationOnScreen(position)
      position[1] + root.height - ime
    } else {
      // Before API 30 the dialog's visible display frame excludes the IME with adjustResize.
      getWindowVisibleDisplayFrame(visibleFrame)
      visibleFrame.bottom
    }
    getLocationOnScreen(position)
    val overlap = (position[1] + height - keyboardTop).coerceAtLeast(0)
    if (overlap != lastOverlap) {
      lastOverlap = overlap
      onOverlapChange(mapOf("bottom" to overlap / resources.displayMetrics.density))
    }
    return true
  }
}
