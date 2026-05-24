export type RepoVisibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | 'UNKNOWN';

export interface PostingFlags {
  publicOk?: boolean;
  noAttach?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface GitleaksResult {
  ok: boolean;
  report?: string;
}

export interface PostingPlanInput {
  visibility: RepoVisibility;
  flags: PostingFlags;
  gitleaksResult: GitleaksResult;
  action: 'gist-create' | 'pr-attach';
}

export interface PostingPlan {
  allow: boolean;
  reason: string;
}

export function buildPostingPlan({ visibility, flags, gitleaksResult, action }: PostingPlanInput): PostingPlan {
  const attaches = action === 'pr-attach' || !flags.noAttach;

  if (visibility === 'PUBLIC' && attaches && !flags.publicOk) {
    return {
      allow: false,
      reason: 'public repository requires --public-ok before attaching provenance gist URL',
    };
  }

  if (visibility === 'UNKNOWN' && attaches && !flags.publicOk) {
    return {
      allow: false,
      reason: 'unknown repository visibility requires --public-ok before attaching provenance gist URL',
    };
  }

  if (!gitleaksResult.ok && !flags.force) {
    return {
      allow: false,
      reason: flags.dryRun ? 'gitleaks findings present in dry-run output' : 'gitleaks findings require --force before posting',
    };
  }

  return {
    allow: true,
    reason: flags.dryRun ? 'dry-run allowed; no network mutation will occur' : 'posting permitted',
  };
}
