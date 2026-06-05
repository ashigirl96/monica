use anyhow::Result;

use crate::interfaces::AuthGateway;
use crate::{GithubAuthStatus, GithubDeviceFlow};

pub fn github_auth_status<A>(auth: &A) -> GithubAuthStatus
where
    A: AuthGateway,
{
    auth.status()
}

pub async fn begin_github_device_flow<A>(auth: &A) -> Result<GithubDeviceFlow>
where
    A: AuthGateway,
{
    auth.begin_device_flow().await
}

pub async fn wait_for_github_device_flow<A>(
    auth: &A,
    flow: &GithubDeviceFlow,
) -> Result<GithubAuthStatus>
where
    A: AuthGateway,
{
    auth.wait_for_device_flow(flow).await
}

pub async fn logout_github<A>(auth: &A) -> Result<()>
where
    A: AuthGateway,
{
    auth.logout().await
}
