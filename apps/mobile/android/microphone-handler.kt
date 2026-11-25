  // The WebView gives us the requesting origin here; the Rust callback does not.
  private var aelysPendingAudio: PermissionRequest? = null
  private var aelysAudioDialog: android.app.AlertDialog? = null

  private fun aelysTrustedOrigin(origin: android.net.Uri): Boolean {
    return origin.scheme == "http" && origin.host == "tauri.localhost" &&
      origin.port == -1 && origin.userInfo == null &&
      (origin.path.isNullOrEmpty() || origin.path == "/") &&
      origin.query == null && origin.fragment == null
  }

  private fun aelysHandleMicrophone(request: PermissionRequest): Boolean {
    val resources = request.resources.toList()
    if (!resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) return false
    val origin = request.origin
    if (resources.size != 1 || !aelysTrustedOrigin(origin) || aelysPendingAudio != null) {
      request.deny()
      return true
    }
    aelysPendingAudio = request
    val dialog = android.app.AlertDialog.Builder(activity)
      .setMessage("Allow Aelys to use the microphone for voice and English practice?")
      .setNegativeButton(android.R.string.cancel) { _, _ -> aelysFinishAudio(request, false) }
      .setPositiveButton(android.R.string.ok) { _, _ ->
        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO)) { granted ->
          aelysFinishAudio(request, granted == true)
        }
      }
      .setOnCancelListener { aelysFinishAudio(request, false) }
      .create()
    aelysAudioDialog = dialog
    dialog.show()
    return true
  }

  private fun aelysFinishAudio(request: PermissionRequest, granted: Boolean) {
    if (aelysPendingAudio !== request) return
    aelysPendingAudio = null
    aelysAudioDialog = null
    if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
  }

  override fun onPermissionRequestCanceled(request: PermissionRequest) {
    if (aelysPendingAudio === request) {
      aelysPendingAudio = null
      aelysAudioDialog?.dismiss()
      aelysAudioDialog = null
    }
    super.onPermissionRequestCanceled(request)
  }
