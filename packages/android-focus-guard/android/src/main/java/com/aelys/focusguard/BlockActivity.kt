package com.aelys.focusguard

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.window.OnBackInvokedDispatcher
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Full-screen block shown by [FocusAccessibilityService]. Native and offline: it reads only the local
 * state, so it works when Aelys is not running. Extras: `app_id`, `used_seconds`, `limit_seconds`.
 */
class BlockActivity : Activity() {
    private lateinit var titleView: TextView
    private lateinit var usedView: TextView
    private var appId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        titleView = text(26f, bold = true)
        usedView = text(16f)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(dp(32), dp(32), dp(32), dp(32))
            addView(titleView)
            addView(usedView, margins(top = 12))
            addView(button(R.string.block_go_home) { goHome() }, margins(top = 40))
            addView(button(R.string.block_unlock) { unlock() }, margins(top = 12))
        }
        setContentView(root)
        render(intent)
        // Predictive back (targetSdk 33+) no longer calls onBackPressed, so register for it too.
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goHome() }
        }
    }

    /** singleTask: a second block of the same app lands here instead of stacking a new screen. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        render(intent)
    }

    @Deprecated("Used below API 33; newer versions use the back-invoked callback above")
    override fun onBackPressed() = goHome()

    private fun render(i: Intent) {
        appId = i.getStringExtra(EXTRA_APP_ID).orEmpty()
        val label = FocusStore.of(this).load().effective.firstOrNull { it.id == appId }?.label ?: appId
        titleView.text = getString(R.string.block_title, label)
        usedView.text = getString(R.string.block_used, minutes(i.getLongExtra(EXTRA_USED, 0)), minutes(i.getLongExtra(EXTRA_LIMIT, 0)))
    }

    private fun minutes(seconds: Long) = getString(R.string.block_minutes, seconds / 60)

    private fun goHome() {
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    /** Hands off to Aelys (the web layer picks the pending id up and offers the unlock options). */
    private fun unlock() {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch == null) {
            Log.w(TAG, "no launch intent for $packageName")
            return
        }
        // This process also hosts the Aelys WebView: a failure here must not take it down. On failure
        // the block screen stays (no unlock, the app stays blocked) and the owner can still press Go Home.
        try {
            FocusStore.of(this).setPendingUnlock(appId)
            startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        } catch (e: Exception) {
            Log.e(TAG, "unlock failed", e)
            // Do not leave a stale pending unlock for the web layer.
            try {
                FocusStore.of(this).setPendingUnlock(null)
            } catch (e2: Exception) {
                Log.e(TAG, "clearing the pending unlock failed", e2)
            }
        }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun margins(top: Int) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        .apply { topMargin = dp(top) }

    private fun text(sp: Float, bold: Boolean = false) = TextView(this).apply {
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        gravity = Gravity.CENTER
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun button(label: Int, onClick: () -> Unit) = Button(this).apply {
        setText(label)
        setOnClickListener { onClick() }
    }

    companion object {
        const val EXTRA_APP_ID = "app_id"
        const val EXTRA_USED = "used_seconds"
        const val EXTRA_LIMIT = "limit_seconds"
        private const val TAG = "FocusGuard"
    }
}
