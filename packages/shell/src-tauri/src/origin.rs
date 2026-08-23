use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::Url;

use crate::commands::NativeError;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct GatewayTarget {
    pub origin: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CanonicalOrigin(String);

impl CanonicalOrigin {
    pub fn parse(raw: &str) -> Result<Self, NativeError> {
        let parsed = Url::parse(raw).map_err(|_| NativeError::invalid_origin())?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(NativeError::invalid_origin());
        }
        if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(NativeError::invalid_origin());
        }

        let host = parsed.host_str().ok_or_else(NativeError::invalid_origin)?;
        match parsed.scheme() {
            "https" => {}
            "http" if is_literal_loopback(host) => {}
            _ => return Err(NativeError::insecure_origin()),
        }

        Ok(Self(parsed.origin().ascii_serialization()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn request_url(&self, raw_path: &str) -> Result<Url, NativeError> {
        validate_gateway_path(raw_path)?;
        let base =
            Url::parse(&format!("{}/", self.0)).map_err(|_| NativeError::invalid_origin())?;
        let joined = base
            .join(raw_path)
            .map_err(|_| NativeError::invalid_path())?;
        if joined.origin().ascii_serialization() != self.0 {
            return Err(NativeError::invalid_path());
        }
        Ok(joined)
    }
}

fn is_literal_loopback(host: &str) -> bool {
    let address = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    address.eq_ignore_ascii_case("localhost")
        || address
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub fn validate_gateway_path(path: &str) -> Result<(), NativeError> {
    let path_only = path.split('?').next().unwrap_or(path);
    let lowered = path_only.to_ascii_lowercase();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path_only.split('/').any(|part| part == "." || part == "..")
        || lowered.contains("%2e")
        || lowered.contains("%5c")
        || lowered.contains("%2f")
    {
        return Err(NativeError::invalid_path());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_gateway_path, CanonicalOrigin};

    #[test]
    fn http_is_limited_to_literal_loopback() {
        for allowed in [
            "http://localhost:7779",
            "http://127.0.0.1:7779",
            "http://127.99.1.4:7779",
            "http://[::1]:7779",
        ] {
            assert!(CanonicalOrigin::parse(allowed).is_ok(), "{allowed}");
        }
        for denied in [
            "http://0.0.0.0:7779",
            "http://192.168.1.4:7779",
            "http://10.0.0.4:7779",
            "http://example.com:7779",
        ] {
            assert!(CanonicalOrigin::parse(denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn https_is_allowed_but_only_as_an_origin() {
        assert_eq!(
            CanonicalOrigin::parse("https://gateway.example:7780")
                .unwrap()
                .as_str(),
            "https://gateway.example:7780"
        );
        for denied in [
            "https://user:secret@gateway.example",
            "https://gateway.example/todos",
            "https://gateway.example/?token=x",
            "https://gateway.example/#x",
            "ftp://gateway.example",
        ] {
            assert!(CanonicalOrigin::parse(denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn ports_are_part_of_the_credential_scope() {
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn gateway_paths_cannot_escape_or_smuggle_an_authority() {
        assert!(validate_gateway_path("/api/sessions?limit=10").is_ok());
        for denied in [
            "api/sessions",
            "//example.com/api",
            "/../api",
            "/%2e%2e/api",
            "/api\\evil",
            "/api%2f%2fevil",
            "/api#fragment",
        ] {
            assert!(validate_gateway_path(denied).is_err(), "{denied}");
        }
    }
}
