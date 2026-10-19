// File System Access API 类型补充。
//
// TS 内置 lib.dom 已包含 FileSystemDirectoryHandle / getDirectoryHandle / getFileHandle /
// createWritable 等，但尚未包含 window.showDirectoryPicker 与权限查询方法，这里补齐。
// 仅声明类型，不产生任何运行时代码。

type FileSystemPermissionMode = "read" | "readwrite";

interface FileSystemHandlePermissionDescriptor {
    mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
    // lib.dom 未声明目录遍历方法，这里补齐（dir.iterable 已启用，返回异步迭代器）。
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

interface DirectoryPickerOptions {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: FileSystemHandle | string;
}

interface Window {
    // 非所有浏览器都实现，故声明为可选，调用方必须先做特性检测。
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
