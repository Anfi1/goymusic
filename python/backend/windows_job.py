"""Срок жизни десктопного бэкенда и его потомков задает Windows, а не обработчик выхода."""
import ctypes as ct
from ctypes import wintypes as wt
import os
from _winapi import (CloseHandle, DuplicateHandle, GetCurrentProcess, OpenProcess,
                     DUPLICATE_SAME_ACCESS, PROCESS_DUP_HANDLE)


class _BasicLimits(ct.Structure):
    _fields_ = [('process_time', ct.c_int64), ('job_time', ct.c_int64), ('flags', wt.DWORD),
                ('min_ws', ct.c_size_t), ('max_ws', ct.c_size_t), ('processes', wt.DWORD),
                ('affinity', ct.c_size_t), ('priority', wt.DWORD), ('scheduling', wt.DWORD)]


class _ExtendedLimits(ct.Structure):
    _fields_ = [('basic', _BasicLimits), ('io_counters', ct.c_uint64 * 6),
                ('memory_limits_and_peaks', ct.c_size_t * 4)]


def bind_to_desktop():
    kernel = ct.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateJobObjectW
    create.argtypes, create.restype = (wt.LPVOID, wt.LPCWSTR), wt.HANDLE
    configure = kernel.SetInformationJobObject
    configure.argtypes, configure.restype = (wt.HANDLE, ct.c_int, wt.LPVOID, wt.DWORD), wt.BOOL
    assign = kernel.AssignProcessToJobObject
    assign.argtypes, assign.restype = (wt.HANDLE, wt.HANDLE), wt.BOOL
    times = kernel.GetProcessTimes
    times.argtypes, times.restype = (wt.HANDLE, *(ct.POINTER(wt.FILETIME),) * 4), wt.BOOL

    def created(handle):
        start, end, system, user = (wt.FILETIME() for _ in range(4))
        if not times(handle, ct.byref(start), ct.byref(end), ct.byref(system), ct.byref(user)):
            raise ct.WinError(ct.get_last_error())
        return (start.dwHighDateTime, start.dwLowDateTime)

    # Не передаем handle постороннему процессу, если Electron умер, а PID уже переиспользован.
    owner = OpenProcess(PROCESS_DUP_HANDLE | 0x1000, False, int(os.environ.pop('GOYMUSIC_DESKTOP_PID')))
    try:
        current = GetCurrentProcess()
        if created(owner) > created(current):
            raise RuntimeError('Desktop process exited before backend initialization')
        job = create(None, None)
        if not job:
            raise ct.WinError(ct.get_last_error())
        try:
            limits = _ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not configure(job, 9, ct.byref(limits), ct.sizeof(limits)):  # JobObjectExtendedLimitInformation
                raise ct.WinError(ct.get_last_error())
            if not assign(job, current):
                raise ct.WinError(ct.get_last_error())
            # Единственный оставшийся handle принадлежит Electron и не наследуется установщиком.
            DuplicateHandle(current, job, owner, 0, False, DUPLICATE_SAME_ACCESS)
        finally:
            CloseHandle(job)
    finally:
        CloseHandle(owner)
