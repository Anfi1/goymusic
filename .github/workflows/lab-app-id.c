/* Node-API initialization, x64. The probe returns its exports unchanged. */
#include <windows.h>
#include <shobjidl_core.h>

__declspec(dllexport) void *napi_register_module_v1(void *env, void *exports)
{
    HRESULT hr = SetCurrentProcessExplicitAppUserModelID(L"com.goymusic.app");
    if (FAILED(hr)) ExitProcess((UINT)hr);
    return exports;
}
