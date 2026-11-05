// pi-job.exe: runs a shell command in a named Windows job object so that pi can kill the command's whole
// process tree, including processes whose parent already exited, which `taskkill /T` cannot find.
//
//   pi-job.exe run <name> <command line>   Start <command line> in a new job named <name>; exit with its code.
//   pi-job.exe terminate <name>            Kill every process in the job named <name>.
//   pi-job.exe hold <handle>               Internal: keep an inherited job handle open until the job is empty.
//
// `run` exits when the command's root process exits, like spawning the command directly. Background processes it
// started stay in the job and keep running; a `hold` process keeps the job (and its name) alive for them, so a
// later `terminate` still reaches them. The job kills its processes when its last handle closes, so killing
// `run` before the command exits also kills the tree.
//
// pi generates <name> (letters, digits, '-') and the mode words, so the arguments before the command line are
// split on spaces; the command line after them is passed to CreateProcessW exactly as pi's spawn quoted it.
// No C runtime: entry point `entry`, kernel32 only.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define EXIT_SETUP_FAILED 126
#define EXIT_NOT_FOUND 127
#define MAX_NAME_LENGTH 128
#define HOLD_POLL_MS 1000

// CRT-free builds still need memset for zero-initialized structs the compiler may lower to it.
#ifdef _MSC_VER
#pragma function(memset)
#endif
void* __cdecl memset(void* target, int value, size_t count) {
    volatile unsigned char* bytes = (volatile unsigned char*)target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}

static void write_error(const char* what, DWORD code) {
    char message[160];
    char digits[12];
    int length = 0;
    int digit_count = 0;
    const char* prefix = "pi-job: ";
    for (const char* c = prefix; *c && length < 100; c++) message[length++] = *c;
    for (const char* c = what; *c && length < 100; c++) message[length++] = *c;
    const char* middle = " failed (error ";
    for (const char* c = middle; *c; c++) message[length++] = *c;
    do {
        digits[digit_count++] = (char)('0' + code % 10);
        code /= 10;
    } while (code && digit_count < (int)sizeof(digits));
    while (digit_count) message[length++] = digits[--digit_count];
    message[length++] = ')';
    message[length++] = '\r';
    message[length++] = '\n';
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, (DWORD)length, &written, NULL);
}

static DWORD fail(const char* what) {
    write_error(what, GetLastError());
    return EXIT_SETUP_FAILED;
}

static int is_space(WCHAR c) {
    return c == L' ' || c == L'\t';
}

static const WCHAR* skip_spaces(const WCHAR* cursor) {
    while (is_space(*cursor)) cursor++;
    return cursor;
}

// Skips argv[0] with the rules CreateProcessW uses: a quoted path runs to the next quote, otherwise to a space.
static const WCHAR* skip_program(const WCHAR* cursor) {
    if (*cursor == L'"') {
        cursor++;
        while (*cursor && *cursor != L'"') cursor++;
        if (*cursor) cursor++;
    }
    while (*cursor && !is_space(*cursor)) cursor++;
    return skip_spaces(cursor);
}

// Copies the next space-delimited word into `word`; returns the position after it, or NULL when it is missing or
// too long.
static const WCHAR* read_word(const WCHAR* cursor, WCHAR* word, int capacity) {
    int length = 0;
    while (*cursor && !is_space(*cursor)) {
        if (length + 1 >= capacity) return NULL;
        word[length++] = *cursor++;
    }
    word[length] = 0;
    return length ? skip_spaces(cursor) : NULL;
}

static int words_equal(const WCHAR* left, const WCHAR* right) {
    while (*left && *left == *right) {
        left++;
        right++;
    }
    return *left == *right;
}

// Job names come from pi; restricting them keeps them out of other kernel namespaces such as "Global\".
static int is_valid_name(const WCHAR* name) {
    for (const WCHAR* c = name; *c; c++) {
        int allowed = (*c >= L'a' && *c <= L'z') || (*c >= L'A' && *c <= L'Z') || (*c >= L'0' && *c <= L'9') ||
            *c == L'-';
        if (!allowed) return 0;
    }
    return 1;
}

static DWORD active_processes(HANDLE job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information = {0};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &information, sizeof(information), NULL)) {
        return 0;
    }
    return information.ActiveProcesses;
}

static BOOL WINAPI ignore_interrupts(DWORD event) {
    // The command shares the console and handles Ctrl+C itself; `run` must outlive it to report its exit code.
    // A handler is used instead of SetConsoleCtrlHandler(NULL, TRUE), which the command would inherit.
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

static HANDLE inheritable_copy(HANDLE handle) {
    HANDLE copy = NULL;
    if (!handle || handle == INVALID_HANDLE_VALUE) return NULL;
    HANDLE self = GetCurrentProcess();
    if (!DuplicateHandle(self, handle, self, &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return NULL;
    return copy;
}

static void format_handle(WCHAR* target, ULONG_PTR value) {
    WCHAR digits[24];
    int count = 0;
    do {
        digits[count++] = (WCHAR)(L'0' + value % 10);
        value /= 10;
    } while (value);
    while (count) *target++ = digits[--count];
    *target = 0;
}

// Starts `hold` with only the job handle inherited: no stdio, so pi's pipes still close when the processes
// writing to them exit, and no console. It runs in the system directory so it never keeps the command's working
// directory in use.
static BOOL start_holder(HANDLE job) {
    WCHAR self[MAX_PATH];
    WCHAR system_directory[MAX_PATH];
    DWORD self_length = GetModuleFileNameW(NULL, self, MAX_PATH);
    if (!self_length || self_length >= MAX_PATH) return FALSE;
    DWORD system_length = GetSystemDirectoryW(system_directory, MAX_PATH);
    if (!system_length || system_length >= MAX_PATH) return FALSE;
    HANDLE inherited = inheritable_copy(job);
    if (!inherited) return FALSE;

    WCHAR command_line[MAX_PATH + 40];
    int length = 0;
    command_line[length++] = L'"';
    for (DWORD i = 0; i < self_length; i++) command_line[length++] = self[i];
    const WCHAR* hold = L"\" hold ";
    for (const WCHAR* c = hold; *c; c++) command_line[length++] = *c;
    format_handle(command_line + length, (ULONG_PTR)inherited);

    SIZE_T attribute_size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = HeapAlloc(GetProcessHeap(), 0, attribute_size);
    BOOL started = FALSE;
    if (attributes && InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) {
        if (UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited, sizeof(inherited),
                NULL, NULL)) {
            STARTUPINFOEXW startup = {0};
            startup.StartupInfo.cb = sizeof(startup);
            startup.lpAttributeList = attributes;
            PROCESS_INFORMATION process = {0};
            started = CreateProcessW(self, command_line, NULL, NULL, TRUE,
                EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, NULL, system_directory,
                &startup.StartupInfo, &process);
            if (started) {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        }
        DeleteProcThreadAttributeList(attributes);
    }
    if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(inherited);
    return started;
}

// Lets the job's processes outlive `run` when no holder could be started, as they did before job objects.
static void keep_processes_on_close(HANDLE job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
}

static DWORD run(const WCHAR* name, const WCHAR* command_line_text) {
    SetConsoleCtrlHandler(ignore_interrupts, TRUE);

    // CreateProcessW may write to the command line buffer, so it gets a copy of our own (read-only) one.
    SIZE_T command_line_size = ((SIZE_T)lstrlenW(command_line_text) + 1) * sizeof(WCHAR);
    WCHAR* command_line = HeapAlloc(GetProcessHeap(), 0, command_line_size);
    if (!command_line) return fail("HeapAlloc");
    for (SIZE_T i = 0; i < command_line_size / sizeof(WCHAR); i++) command_line[i] = command_line_text[i];

    HANDLE job = CreateJobObjectW(NULL, name);
    if (!job) return fail("CreateJobObjectW");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        write_error("CreateJobObjectW (name in use)", ERROR_ALREADY_EXISTS);
        return EXIT_SETUP_FAILED;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    // Unhandled exceptions end the process instead of opening an error dialog that would keep the job alive.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        return fail("SetInformationJobObject");
    }

    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = inheritable_copy(GetStdHandle(STD_INPUT_HANDLE));
    startup.hStdOutput = inheritable_copy(GetStdHandle(STD_OUTPUT_HANDLE));
    startup.hStdError = inheritable_copy(GetStdHandle(STD_ERROR_HANDLE));
    PROCESS_INFORMATION process = {0};
    // Suspended until it is in the job: a process it starts before the assignment would escape the job.
    BOOL created = CreateProcessW(NULL, command_line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        NULL, NULL, &startup, &process);
    DWORD create_error = GetLastError();
    if (startup.hStdInput) CloseHandle(startup.hStdInput);
    if (startup.hStdOutput) CloseHandle(startup.hStdOutput);
    if (startup.hStdError) CloseHandle(startup.hStdError);
    if (!created) {
        write_error("CreateProcessW", create_error);
        return create_error == ERROR_FILE_NOT_FOUND || create_error == ERROR_PATH_NOT_FOUND ? EXIT_NOT_FOUND
                                                                                            : EXIT_SETUP_FAILED;
    }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        DWORD code = fail("AssignProcessToJobObject");
        TerminateProcess(process.hProcess, code);
        return code;
    }
    if (ResumeThread(process.hThread) == (DWORD)-1) {
        DWORD code = fail("ResumeThread");
        TerminateJobObject(job, code);
        return code;
    }
    CloseHandle(process.hThread);

    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = EXIT_SETUP_FAILED;
    GetExitCodeProcess(process.hProcess, &exit_code);
    if (active_processes(job) > 0 && !start_holder(job)) keep_processes_on_close(job);
    return exit_code;
}

static DWORD terminate(const WCHAR* name) {
    HANDLE job = OpenJobObjectW(JOB_OBJECT_TERMINATE, FALSE, name);
    // No job means nothing is left to kill: the command and its holder already ended.
    if (!job) return 1;
    return TerminateJobObject(job, 1) ? 0 : fail("TerminateJobObject");
}

static DWORD hold(const WCHAR* handle_text) {
    ULONG_PTR value = 0;
    for (const WCHAR* c = handle_text; *c; c++) {
        if (*c < L'0' || *c > L'9') return EXIT_SETUP_FAILED;
        value = value * 10 + (ULONG_PTR)(*c - L'0');
    }
    HANDLE job = (HANDLE)value;
    // Polling keeps this process trivial; it only decides when the holder exits, never what gets killed.
    while (active_processes(job) > 0) Sleep(HOLD_POLL_MS);
    return 0;
}

static DWORD dispatch(void) {
    WCHAR mode[16];
    WCHAR argument[MAX_NAME_LENGTH];
    const WCHAR* cursor = skip_program(GetCommandLineW());
    cursor = read_word(cursor, mode, sizeof(mode) / sizeof(mode[0]));
    if (!cursor) return EXIT_SETUP_FAILED;
    const WCHAR* rest = read_word(cursor, argument, sizeof(argument) / sizeof(argument[0]));

    if (words_equal(mode, L"hold") && rest) return hold(argument);
    if (!rest || !is_valid_name(argument)) {
        write_error("argument parsing", ERROR_INVALID_PARAMETER);
        return EXIT_SETUP_FAILED;
    }
    if (words_equal(mode, L"terminate")) return terminate(argument);
    if (words_equal(mode, L"run") && *rest) return run(argument, rest);
    write_error("argument parsing", ERROR_INVALID_PARAMETER);
    return EXIT_SETUP_FAILED;
}

void __cdecl entry(void) {
    ExitProcess(dispatch());
}
