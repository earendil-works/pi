use std::time::Duration;

/// Retry configuration for API calls.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub max_retry_delay_ms: Option<u64>,
}

impl Default for RetryConfig {
    fn default() -> Self {
        RetryConfig {
            max_retries: 2,
            initial_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(60),
            max_retry_delay_ms: Some(60_000),
        }
    }
}

impl RetryConfig {
    pub fn new(max_retries: u32) -> Self {
        RetryConfig {
            max_retries,
            ..Default::default()
        }
    }

    /// Calculate the delay for a given retry attempt (exponential backoff).
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let delay = self.initial_delay * 2u32.pow(attempt);
        let capped = std::cmp::min(delay, self.max_delay);
        if let Some(max_ms) = self.max_retry_delay_ms {
            std::cmp::min(capped, Duration::from_millis(max_ms))
        } else {
            capped
        }
    }
}

/// Retry an async operation with exponential backoff.
///
/// Returns the result of the first successful attempt, or the last error.
pub async fn retry_async<F, Fut, T, E>(
    mut operation: F,
    config: &RetryConfig,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Debug,
{
    let mut last_error = None;

    for attempt in 0..=config.max_retries {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                last_error = Some(e);
                if attempt < config.max_retries {
                    let delay = config.delay_for_attempt(attempt);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    Err(last_error.unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delay_backoff() {
        let config = RetryConfig::default();
        let d0 = config.delay_for_attempt(0);
        let d1 = config.delay_for_attempt(1);
        let d2 = config.delay_for_attempt(2);

        assert!(d1 >= d0);
        assert!(d2 >= d1);
    }

    #[tokio::test]
    async fn test_retry_success_first_attempt() {
        let config = RetryConfig::new(2);
        let mut calls = 0;

        let result = retry_async(
            || {
                calls += 1;
                async move { Ok::<_, &str>(42) }
            },
            &config,
        )
        .await;

        assert_eq!(result, Ok(42));
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn test_retry_eventual_success() {
        let config = RetryConfig::new(3);
        let mut calls = 0;

        let result = retry_async(
            || {
                calls += 1;
                async move {
                    if calls < 3 {
                        Err("fail")
                    } else {
                        Ok(42)
                    }
                }
            },
            &config,
        )
        .await;

        assert_eq!(result, Ok(42));
        assert_eq!(calls, 3);
    }
}
