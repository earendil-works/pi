/// Execution environment abstraction for filesystem and shell operations.
library;

import 'dart:io' as io;

/// File kind classification.
enum FileKind {
  /// Regular file.
  file,

  /// Directory.
  directory,

  /// Symbolic link.
  symlink,
}

/// File metadata.
class FileInfo {
  /// Absolute path.
  final String path;

  /// File kind (file, directory, or symlink).
  final FileKind kind;

  /// File size in bytes.
  final int size;

  /// Last modification time.
  final DateTime modified;

  /// Creates file info.
  const FileInfo({
    required this.path,
    required this.kind,
    required this.size,
    required this.modified,
  });
}

/// Shell command execution result.
class ShellResult {
  /// Captured standard output.
  final String stdout;

  /// Captured standard error.
  final String stderr;

  /// Process exit code.
  final int exitCode;

  /// Creates a shell result.
  const ShellResult({
    required this.stdout,
    required this.stderr,
    required this.exitCode,
  });

  /// Whether the command succeeded (exit code 0).
  bool get success => exitCode == 0;
}

/// Error codes for file operations.
enum FileErrorCode {
  /// File or directory not found.
  notFound,

  /// Path is not a directory.
  notDirectory,

  /// Permission denied.
  permissionDenied,

  /// Generic I/O error.
  ioError,
}

/// Exception for file operation errors.
class FileError implements Exception {
  /// Path that caused the error.
  final String path;

  /// Error code.
  final FileErrorCode code;

  /// Human-readable error message.
  final String message;

  /// Creates a file error.
  const FileError({
    required this.path,
    required this.code,
    required this.message,
  });

  @override
  String toString() => 'FileError($code): $message (path: $path)';
}

/// Abstract execution environment for filesystem and shell operations.
abstract class ExecutionEnv {
  /// Read file contents at [path].
  Future<String> readFile(String path);

  /// Write [content] to file at [path].
  Future<void> writeFile(String path, String content);

  /// List directory entries at [path].
  Future<List<String>> listDirectory(String path);

  /// Remove file at [path].
  Future<void> removeFile(String path);

  /// Get file metadata at [path].
  Future<FileInfo> fileInfo(String path);

  /// Check if a file exists at [path].
  Future<bool> fileExists(String path);

  /// Execute a shell [command].
  Future<ShellResult> exec(
    String command, {
    String? workingDirectory,
    Map<String, String>? environment,
    bool Function()? isAborted,
  });

  /// Create a temporary file and return its path.
  Future<String> createTempFile({String? prefix, String? suffix});

  /// Create a temporary directory and return its path.
  Future<String> createTempDirectory({String? prefix});
}

/// Default line limit for truncated output.
const int defaultMaxLines = 2000;

/// Default byte limit for truncated output.
const int defaultMaxBytes = 51200;

/// Maximum line length for grep-style output.
const int grepMaxLineLength = 512;

/// Local execution environment using dart:io.
///
/// Provides real filesystem and shell operations for Dart VM environments.
class LocalExecutionEnv implements ExecutionEnv {
  @override
  Future<String> readFile(String path) async {
    final file = io.File(path);
    if (!await file.exists()) {
      throw FileError(
          path: path, code: FileErrorCode.notFound, message: 'File not found');
    }
    return file.readAsString();
  }

  @override
  Future<void> writeFile(String path, String content) async {
    final file = io.File(path);
    await file.writeAsString(content);
  }

  @override
  Future<List<String>> listDirectory(String path) async {
    final dir = io.Directory(path);
    if (!await dir.exists()) {
      throw FileError(
          path: path,
          code: FileErrorCode.notFound,
          message: 'Directory not found');
    }
    return dir.listSync().map((e) => e.path).toList();
  }

  @override
  Future<void> removeFile(String path) async {
    final file = io.File(path);
    if (!await file.exists()) {
      throw FileError(
          path: path, code: FileErrorCode.notFound, message: 'File not found');
    }
    await file.delete();
  }

  @override
  Future<FileInfo> fileInfo(String path) async {
    final type = await io.FileSystemEntity.type(path);
    if (type == io.FileSystemEntityType.notFound) {
      throw FileError(
          path: path, code: FileErrorCode.notFound, message: 'Not found');
    }

    final kind = switch (type) {
      io.FileSystemEntityType.file => FileKind.file,
      io.FileSystemEntityType.directory => FileKind.directory,
      io.FileSystemEntityType.link => FileKind.symlink,
      _ => FileKind.file,
    };

    final stat = await io.FileStat.stat(path);
    return FileInfo(
      path: path,
      kind: kind,
      size: stat.size,
      modified: stat.modified,
    );
  }

  @override
  Future<bool> fileExists(String path) async => io.File(path).exists();

  @override
  Future<ShellResult> exec(
    String command, {
    String? workingDirectory,
    Map<String, String>? environment,
    bool Function()? isAborted,
  }) async {
    final result = await io.Process.run(
      '/bin/sh',
      ['-c', command],
      workingDirectory: workingDirectory,
      environment: environment,
    );

    return ShellResult(
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    );
  }

  @override
  Future<String> createTempFile({String? prefix, String? suffix}) async {
    final tempDir = io.Directory.systemTemp;
    final name =
        '${prefix ?? 'pi_agent'}${DateTime.now().microsecondsSinceEpoch}${suffix ?? '.tmp'}';
    final file = io.File('${tempDir.path}/$name');
    await file.create();
    return file.path;
  }

  @override
  Future<String> createTempDirectory({String? prefix}) async {
    final tempDir = io.Directory.systemTemp;
    final name =
        '${prefix ?? 'pi_agent'}${DateTime.now().microsecondsSinceEpoch}';
    final dir = io.Directory('${tempDir.path}/$name');
    await dir.create();
    return dir.path;
  }
}

/// Truncates text keeping the first [maxLines] lines or [maxBytes] bytes.
String truncateHead(
  String text, {
  int? maxLines,
  int? maxBytes,
}) {
  maxLines ??= defaultMaxLines;
  maxBytes ??= defaultMaxBytes;

  var lines = text.split('\n');
  if (lines.length > maxLines) {
    lines = lines.sublist(0, maxLines);
  }

  var result = lines.join('\n');
  if (result.length > maxBytes) {
    result = result.substring(0, maxBytes);
  }

  return result;
}

/// Truncates text keeping the last [maxLines] lines or [maxBytes] bytes.
String truncateTail(
  String text, {
  int? maxLines,
  int? maxBytes,
}) {
  maxLines ??= defaultMaxLines;
  maxBytes ??= defaultMaxBytes;

  var lines = text.split('\n');
  if (lines.length > maxLines) {
    lines = lines.sublist(lines.length - maxLines);
  }

  var result = lines.join('\n');
  if (result.length > maxBytes) {
    result = result.substring(result.length - maxBytes);
  }

  return result;
}

/// Formats a byte count as a human-readable string.
String formatSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)}MB';
}
