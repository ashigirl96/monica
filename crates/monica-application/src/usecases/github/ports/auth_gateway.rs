use crate::GithubAuthStatus;

pub trait AuthGateway {
    fn status(&self) -> GithubAuthStatus;
}
