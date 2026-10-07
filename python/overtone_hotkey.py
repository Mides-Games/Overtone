"""One global hotkey, delivered by the OS, never hooked (Phase 26, row 26.19).

The reference tool watches every keystroke through a ``WH_KEYBOARD_LL`` hook,
which is where its input-lag issues live. ``RegisterHotKey`` is the opposite:
the OS delivers one registered combination as a ``WM_HOTKEY`` message and no
other keystroke passes through Overtone at all.

The wait runs on its own thread with a message-only window, so no visible
window and no message pump of the app is involved; the callback fires there
and must hand back quickly (the Train build starts its own worker, like the
button). Windows only: anywhere else the wait refuses with the reason rather
than pretending.
"""

from __future__ import annotations

import os
import threading

#: The one combination: Ctrl+Alt+B for "build the copy I have set up".
MODIFIERS = 0x0002 | 0x0001  # MOD_CONTROL | MOD_ALT
VIRTUAL_KEY = 0x42  # 'B'

WM_HOTKEY = 0x0312
WM_DESTROY = 0x0002


def available() -> bool:
    """Whether this machine can wait on a hotkey: Windows, with user32."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        return hasattr(ctypes.windll, "user32")
    except (OSError, AttributeError):
        return False


class HotkeyWait(threading.Thread):
    """A message-only window waiting for one combination, then calling back.

    ``callback`` runs on this thread: hand back quickly. ``stop()`` unregisters
    and ends the wait; the window dies with the thread, registered or not, so
    a combination is never held past its waiter.
    """

    def __init__(self, hotkey_id: int = 1, modifiers: int = MODIFIERS,
                 virtual_key: int = VIRTUAL_KEY, callback=None) -> None:
        super().__init__(daemon=True, name="train-hotkey")
        self.hotkey_id = int(hotkey_id)
        self.modifiers = int(modifiers)
        self.virtual_key = int(virtual_key)
        self.callback = callback
        self.ready = threading.Event()
        self.fired = threading.Event()
        self.error: str | None = None
        self._stop = threading.Event()
        self._handle = None

    def run(self) -> None:
        import ctypes
        from ctypes import wintypes

        WNDPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND,
                                     wintypes.UINT, wintypes.WPARAM,
                                     wintypes.LPARAM)

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [("style", wintypes.UINT),
                        ("lpfnWndProc", WNDPROC),
                        ("cbClsExtra", ctypes.c_int),
                        ("cbWndExtra", ctypes.c_int),
                        ("hInstance", wintypes.HINSTANCE),
                        ("hIcon", wintypes.HICON),
                        ("hCursor", wintypes.HCURSOR),
                        ("hbrBackground", wintypes.HBRUSH),
                        ("lpszMenuName", wintypes.LPCWSTR),
                        ("lpszClassName", wintypes.LPCWSTR)]

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        class MSG(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND),
                        ("message", wintypes.UINT),
                        ("wParam", wintypes.WPARAM),
                        ("lParam", wintypes.LPARAM),
                        ("time", wintypes.DWORD),
                        ("pt", POINT)]

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        user32.RegisterClassW.restype = wintypes.ATOM
        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.RegisterHotKey.argtypes = [
            wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        user32.RegisterHotKey.restype = wintypes.BOOL
        user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.UnregisterHotKey.restype = wintypes.BOOL
        user32.PostMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.PostMessageW.restype = wintypes.BOOL
        user32.GetMessageW.argtypes = [
            ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        user32.GetMessageW.restype = wintypes.BOOL
        user32.DefWindowProcW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = wintypes.LPARAM
        user32.PostQuitMessage.argtypes = [ctypes.c_int]
        user32.PostQuitMessage.restype = None

        @WNDPROC
        def procedure(handle, message, wparam, _lparam):
            if message == WM_HOTKEY and int(wparam) == self.hotkey_id:
                self.fired.set()
                try:
                    if self.callback is not None:
                        self.callback()
                except Exception:  # noqa: BLE001 -- a callback never ends the wait
                    pass
            if message == WM_DESTROY:
                # The only way out of GetMessage: post the quit it waits for.
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(handle, message, wparam, _lparam)

        cls = WNDCLASSW()
        cls.lpfnWndProc = procedure
        cls.hInstance = kernel32.GetModuleHandleW(None)
        cls.lpszClassName = f"OvertoneTrainHotkey{self.hotkey_id}"
        if not user32.RegisterClassW(ctypes.byref(cls)):
            # Twice in one process: the class is already there, which is fine.
            if kernel32.GetLastError() != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                self.error = "no message window class"
                self.ready.set()
                return
        # Never shown: no parent, no style, still a valid hotkey target.
        handle = user32.CreateWindowExW(0, cls.lpszClassName, None, 0, 0, 0, 0, 0,
                                        None, None, cls.hInstance, None)
        if not handle:
            self.error = "no message window"
            self.ready.set()
            return
        self._handle = handle
        if not user32.RegisterHotKey(handle, self.hotkey_id,
                                     self.modifiers, self.virtual_key):
            self.error = (f"combination taken (RegisterHotKey refused id "
                          f"{self.hotkey_id})")
            user32.DestroyWindow(handle)
            self._handle = None
            self.ready.set()
            return
        self.ready.set()
        message = MSG()
        while not self._stop.is_set():
            status = user32.GetMessageW(ctypes.byref(message), None, 0, 0)
            if status <= 0:
                break
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))
        try:
            user32.UnregisterHotKey(handle, self.hotkey_id)
        except (OSError, ValueError):
            pass
        try:
            user32.DestroyWindow(handle)
        except (OSError, ValueError):
            pass
        self._handle = None

    def stop(self, timeout: float = 5.0) -> None:
        """Unregister and end the wait, from any thread."""
        self._stop.set()
        if self._handle:
            try:
                import ctypes

                ctypes.windll.user32.PostMessageW(self._handle, WM_DESTROY, 0, 0)
            except (OSError, ValueError, AttributeError):
                pass
        self.join(timeout=timeout)
