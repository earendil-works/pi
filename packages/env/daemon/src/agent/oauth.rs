//! The machine's OAuth host grant from the gateway: enrollment by code, the device flow without one, and refresh.

use super::http;
use super::net::Origin;
use serde_json::Value;
use std::time::Duration;

/// The agent's OAuth client.
const CLIENT_ID: &str = "pi-env";
const SCOPE: &str = "host offline_access";
const CODE_GRANT: &str = "urn:radius:params:oauth:grant-type:enrollment_code";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const TIMEOUT: Duration = Duration::from_secs(30);

/// A token response; enrollment fills in the server, the owner and the origin, a refresh may leave them out.
#[derive(Debug, PartialEq)]
pub struct Grant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub server_id: Option<String>,
    pub organization_id: Option<String>,
    pub principal_id: Option<String>,
    pub public_origin: Option<String>,
}

/// Why a token request failed.
#[derive(Debug, PartialEq)]
pub enum TokenError {
    /// The gateway refused the grant (400 or 401, such as `invalid_grant`): a used code, a revoked machine.
    Rejected(String),
    /// Device flow: the owner has not decided yet; `slow_down` asks for a longer interval.
    Pending { slow_down: bool },
    /// Anything else (network, server errors): worth retrying.
    Failed(String),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenError::Rejected(message) | TokenError::Failed(message) => {
                formatter.write_str(message)
            }
            TokenError::Pending { .. } => formatter.write_str("authorization pending"),
        }
    }
}

/// Redeem an enrollment code for server `server_id`.
pub fn redeem_code(
    gateway: &Origin,
    code: &str,
    server_id: &str,
    name: Option<&str>,
) -> Result<Grant, TokenError> {
    let mut fields = vec![
        ("grant_type", CODE_GRANT),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("server_id", server_id),
    ];
    if let Some(name) = name {
        fields.push(("name", name));
    }
    token(gateway, &fields)
}

/// Refresh the access token.
pub fn refresh(gateway: &Origin, refresh_token: &str) -> Result<Grant, TokenError> {
    token(
        gateway,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
        ],
    )
}

/// The device flow (RFC 8628) for server `server_id`: `show` gets the verification URL and the user code to show the
/// owner, then the gateway is polled until the owner approved or refused, or the code expired.
pub fn device_flow(
    gateway: &Origin,
    server_id: &str,
    show: impl FnOnce(&str, &str),
) -> Result<Grant, String> {
    let response = post_form(
        gateway,
        "/v1/oauth/device",
        &[
            ("client_id", CLIENT_ID),
            ("scope", SCOPE),
            ("server_id", server_id),
        ],
    )
    .map_err(|error| format!("device authorization: {error}"))?;
    let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if response.status != 200 {
        return Err(format!(
            "device authorization: {} {}",
            response.status,
            error_text(&value, &response.body)
        ));
    }
    let (Some(device_code), Some(user_code)) =
        (value["device_code"].as_str(), value["user_code"].as_str())
    else {
        return Err("device authorization: invalid response".into());
    };
    let url = value["verification_uri_complete"]
        .as_str()
        .or(value["verification_uri"].as_str())
        .unwrap_or_default();
    show(url, user_code);
    let mut interval = Duration::from_secs_f64(value["interval"].as_f64().unwrap_or(5.0).max(1.0));
    let deadline = std::time::Instant::now()
        + Duration::from_secs(value["expires_in"].as_u64().unwrap_or(900));
    while std::time::Instant::now() < deadline {
        std::thread::sleep(interval);
        let fields = [
            ("grant_type", DEVICE_GRANT),
            ("device_code", device_code),
            ("client_id", CLIENT_ID),
        ];
        match token(gateway, &fields) {
            Ok(grant) => return Ok(grant),
            Err(TokenError::Pending { slow_down }) => {
                if slow_down {
                    interval += Duration::from_secs(5);
                }
            }
            // A network failure while waiting is retried with the next poll.
            Err(TokenError::Failed(_)) => {}
            Err(TokenError::Rejected(message)) => return Err(message),
        }
    }
    Err("the device code expired before it was approved".into())
}

fn token(gateway: &Origin, fields: &[(&str, &str)]) -> Result<Grant, TokenError> {
    let response = post_form(gateway, "/v1/oauth/token", fields)
        .map_err(|error| TokenError::Failed(format!("token request: {error}")))?;
    let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if response.status == 200 {
        return parse_grant(&value)
            .ok_or_else(|| TokenError::Failed("token response without access_token".into()));
    }
    let error = value["error"].as_str().unwrap_or_default();
    let message = format!("{} {}", response.status, error_text(&value, &response.body));
    match (response.status, error) {
        (400, "authorization_pending") => Err(TokenError::Pending { slow_down: false }),
        (400, "slow_down") => Err(TokenError::Pending { slow_down: true }),
        (400 | 401, _) => Err(TokenError::Rejected(message)),
        _ => Err(TokenError::Failed(message)),
    }
}

fn parse_grant(value: &Value) -> Option<Grant> {
    let text = |key: &str| value[key].as_str().map(str::to_string);
    Some(Grant {
        access_token: text("access_token")?,
        refresh_token: text("refresh_token"),
        expires_in: value["expires_in"].as_u64().unwrap_or(3600),
        server_id: text("server_id"),
        organization_id: text("organization_id"),
        principal_id: text("principal_id"),
        public_origin: text("public_origin"),
    })
}

fn error_text(value: &Value, body: &[u8]) -> String {
    match (value["error"].as_str(), value["error_description"].as_str()) {
        (Some(error), Some(description)) => format!("{error}: {description}"),
        (Some(error), None) => error.to_string(),
        _ => String::from_utf8_lossy(&body[..body.len().min(200)]).into_owned(),
    }
}

fn post_form(
    gateway: &Origin,
    path: &str,
    fields: &[(&str, &str)],
) -> std::io::Result<http::Response> {
    let body = fields
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    http::request(
        gateway,
        "POST",
        path,
        &[
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Accept", "application/json"),
        ],
        body.as_bytes(),
        TIMEOUT,
    )
}

/// Percent-encoding of a query or form value: everything but unreserved characters.
pub fn encode(text: &str) -> String {
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_form_values() {
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    }

    #[test]
    fn parses_token_responses() {
        let value = serde_json::json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 60, "server_id": "s",
            "organization_id": "o", "principal_id": "p", "public_origin": "https://x.example"
        });
        let grant = parse_grant(&value).unwrap();
        assert_eq!(grant.expires_in, 60);
        assert_eq!(grant.principal_id.as_deref(), Some("p"));
        assert!(parse_grant(&serde_json::json!({ "refresh_token": "r" })).is_none());
    }
}
