use tauri::Url;

#[derive(Debug, Eq, PartialEq)]
pub enum NavigationDecision {
    Local,
    External,
    Deny,
}

pub fn decide(url: &Url) -> NavigationDecision {
    if matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    ) {
        NavigationDecision::Local
    } else if matches!(url.scheme(), "http" | "https") {
        NavigationDecision::External
    } else {
        NavigationDecision::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, NavigationDecision};
    use tauri::Url;

    #[test]
    fn only_bundled_routes_stay_in_the_webview() {
        assert_eq!(
            decide(&Url::parse("tauri://localhost/org").unwrap()),
            NavigationDecision::Local
        );
        assert_eq!(
            decide(&Url::parse("https://example.com/").unwrap()),
            NavigationDecision::External
        );
        assert_eq!(
            decide(&Url::parse("http://192.168.1.20:7779/").unwrap()),
            NavigationDecision::External
        );
        assert_eq!(
            decide(&Url::parse("javascript:alert(1)").unwrap()),
            NavigationDecision::Deny
        );
    }
}
