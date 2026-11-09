// PCRE2 matching with one UTF-8 validation per subject, including interpreter-only patterns.
use grep_matcher::{Match, Matcher};
use pcre2_sys::*;
use std::{borrow::Cow, io, ptr};

/// Bound each PCRE2 JIT stack while allowing ordinary recursive patterns to match.
pub const JIT_STACK_LIMIT: usize = 10 * 1024 * 1024;

// All pointers are exclusively owned here. A successful constructor initializes code and data;
// context and stack are optional, and partially initialized values are released on errors.
/// Reuse compiled PCRE2 state for validated UTF-8 subjects.
pub struct Utf8Matcher {
    code: *mut pcre2_code_8,
    data: *mut pcre2_match_data_8,
    context: *mut pcre2_match_context_8,
    stack: *mut pcre2_jit_stack_8,
}

impl Utf8Matcher {
    /// Compile the same pattern and matching flags as the malformed-input fallback.
    pub fn new(pattern: &str, caseless: bool, literal: bool) -> io::Result<Self> {
        let pattern = if literal {
            Cow::Owned(regex_syntax::escape(pattern))
        } else {
            Cow::Borrowed(pattern)
        };
        // Match grep-pcre2's grouping and flags, but do not enable MATCH_INVALID_UTF:
        // that option forces the interpreter to revalidate every remaining suffix.
        let pattern = format!("(?:{pattern})");
        let flags =
            PCRE2_UTF | PCRE2_UCP | PCRE2_MULTILINE | if caseless { PCRE2_CASELESS } else { 0 };
        let mut error = 0;
        let mut offset = 0;
        // SAFETY: pattern and both out-parameters remain valid for this synchronous call.
        let code = unsafe {
            pcre2_compile_8(
                pattern.as_ptr(),
                pattern.len(),
                flags,
                &mut error,
                &mut offset,
                ptr::null_mut(),
            )
        };
        if code.is_null() {
            return Err(io::Error::other(format!(
                "{} at offset {offset}",
                error_message(error)
            )));
        }
        let mut matcher = Self {
            code,
            data: ptr::null_mut(),
            context: ptr::null_mut(),
            stack: ptr::null_mut(),
        };
        // SAFETY: code is live; PCRE2 allocates enough space for all captures.
        matcher.data = unsafe { pcre2_match_data_create_from_pattern_8(code, ptr::null_mut()) };
        if matcher.data.is_null() {
            return Err(io::Error::other("PCRE2 match-data allocation failed"));
        }
        // JIT is optional: unsupported patterns still use the validated interpreter path.
        // SAFETY: this compiled code is exclusively owned and has no active matches.
        if unsafe { pcre2_jit_compile_8(code, PCRE2_JIT_COMPLETE) } == 0 {
            // SAFETY: a null general context selects PCRE2's default allocator.
            matcher.context = unsafe { pcre2_match_context_create_8(ptr::null_mut()) };
            if matcher.context.is_null() {
                return Err(io::Error::other("PCRE2 match-context allocation failed"));
            }
            // SAFETY: the bounded stack is owned until after the match context is freed.
            matcher.stack =
                unsafe { pcre2_jit_stack_create_8(32 * 1024, JIT_STACK_LIMIT, ptr::null_mut()) };
            if matcher.stack.is_null() {
                return Err(io::Error::other("PCRE2 JIT-stack allocation failed"));
            }
            // SAFETY: both pointers are live; no callback means the third argument is the stack.
            unsafe { pcre2_jit_stack_assign_8(matcher.context, None, matcher.stack.cast()) };
        }
        Ok(matcher)
    }

    /// Match a validated subject, retaining the existing behavior for non-boundary offsets.
    pub fn find_at<M: Matcher>(
        &mut self,
        subject: &str,
        at: usize,
        fallback: &M,
    ) -> io::Result<Option<Match>> {
        // A byte-oriented pattern such as \C can end inside a UTF-8 character. Retain
        // the original invalid-offset behavior instead of passing an unchecked offset to C.
        if !subject.is_char_boundary(at) {
            return fallback
                .find_at(subject.as_bytes(), at)
                .map_err(|error| io::Error::other(error.to_string()));
        }
        // SAFETY: &str guarantees valid UTF-8, and the check above guarantees a valid
        // start offset. Code/data/context are live, exclusive, and stay so for this call.
        let result = unsafe {
            pcre2_match_8(
                self.code,
                subject.as_ptr(),
                subject.len(),
                at,
                PCRE2_NO_UTF_CHECK,
                self.data,
                self.context,
            )
        };
        if result == PCRE2_ERROR_NOMATCH {
            return Ok(None);
        }
        if result < 0 {
            return Err(io::Error::other(error_message(result)));
        }
        // SAFETY: match data was sized from this pattern; a successful match sets
        // capture zero's two offsets, and its storage remains owned by this matcher.
        let (start, end) = unsafe {
            let offsets = pcre2_get_ovector_pointer_8(self.data);
            (*offsets, *offsets.add(1))
        };
        Ok(Some(Match::new(start, end)))
    }
}

impl Drop for Utf8Matcher {
    fn drop(&mut self) {
        // SAFETY: each non-null pointer is uniquely owned, allocated by PCRE2, and
        // freed exactly once. The stack outlives its context, and code outlives matches.
        unsafe {
            if !self.data.is_null() {
                pcre2_match_data_free_8(self.data);
            }
            if !self.context.is_null() {
                pcre2_match_context_free_8(self.context);
            }
            if !self.stack.is_null() {
                pcre2_jit_stack_free_8(self.stack);
            }
            pcre2_code_free_8(self.code);
        }
    }
}

fn error_message(code: i32) -> String {
    let mut buffer = [0; 256];
    // SAFETY: the output buffer is writable for the supplied length.
    let length = unsafe { pcre2_get_error_message_8(code, buffer.as_mut_ptr(), buffer.len()) };
    if length < 0 {
        return format!("PCRE2 error {code}");
    }
    format!(
        "PCRE2: {}",
        String::from_utf8_lossy(&buffer[..length as usize])
    )
}
