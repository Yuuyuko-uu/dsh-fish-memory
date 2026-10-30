// DSH 0.2.1-rc.2 public Connection API; never parse or mint credentials here.
// Raw webServer routes do not inherit Connection authentication automatically.
export function managementRejection(ctx, request) {
  try {
    const connection = ctx.connection
    if (typeof connection?.admit !== 'function') return 503
    const admission = connection.admit(request)
    if (!admission || typeof admission !== 'object') return 503
    if ('rejection' in admission) {
      return admission.rejection === 403 ? 403 : 401
    }
    if (!admission.peer || admission.peer.signal?.aborted) return 401
    // Signed identity alone does not grant memory administration to other principals.
    return admission.peer.principal?.kind === 'owner' ? 0 : 403
  } catch {
    // An unavailable or incompatible host must never fall back to unauthenticated access.
    return 503
  }
}
