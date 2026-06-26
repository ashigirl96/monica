use super::ports::AuthGateway;
use crate::{ApplicationError, ApplicationResult, GithubAuthStatus, GithubDeviceFlow};

/// Device-flow failures are GitHub-side, not local storage faults.
fn external(error: anyhow::Error) -> ApplicationError {
    ApplicationError::external(format!("{error:#}"))
}

pub fn github_auth_status<A>(auth: &A) -> GithubAuthStatus
where
    A: AuthGateway,
{
    auth.status()
}

pub async fn begin_github_device_flow<A>(auth: &A) -> ApplicationResult<GithubDeviceFlow>
where
    A: AuthGateway,
{
    auth.begin_device_flow().await.map_err(external)
}

pub async fn wait_for_github_device_flow<A>(
    auth: &A,
    flow: &GithubDeviceFlow,
) -> ApplicationResult<GithubAuthStatus>
where
    A: AuthGateway,
{
    auth.wait_for_device_flow(flow).await.map_err(external)
}

pub async fn logout_github<A>(auth: &A) -> ApplicationResult<()>
where
    A: AuthGateway,
{
    auth.logout().await.map_err(external)
}
