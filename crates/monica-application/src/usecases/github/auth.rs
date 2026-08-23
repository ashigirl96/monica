use super::ports::AuthGateway;
use crate::GithubAuthStatus;

pub fn github_auth_status<A>(auth: &A) -> GithubAuthStatus
where
    A: AuthGateway,
{
    auth.status()
}
