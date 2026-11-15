package com.aelys.focusguard

import android.app.Activity
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

@TauriPlugin
class FocusGuardPlugin(activity: Activity) : Plugin(activity)
