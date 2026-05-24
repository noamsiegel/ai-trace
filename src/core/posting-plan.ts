import type { GitleaksFinding } from '../adapters/gitleaks.ts';

export type RepoVisibility = 'public' | 'private' | 'unknown';
export type GhRepoVisibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | 'UNKNOWN';

export interface PostingFlags {
  publicOk: boolean;
  noAttach: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface PostingPlanInput {
  visibility: RepoVisibility;
  flags: PostingFlags;
  gitleaksFindings: GitleaksFinding[];
  action: 'create' | 'reattach';
}

export interface PostingPlan {
  allow: boolean;
  reason: string;
}

export function normalizeRepoVisibility(visibility: GhRepoVisibility): RepoVisibility {
  if (visibility === 'PUBLIC') return 'public';
  if (visibility === 'PRIVATE' || visibility === 'INTERNAL') return 'private';
  return 'unknown';
}

export function buildPostingPlan({ visibility, flags, gitleaksFindings, action }: PostingPlanInput): PostingPlan {
  if (flags.dryRun) {
    return { allow: true, reason: 'dry-run allowed; no network mutation will occur' };
  }

  if (gitleaksFindings.length > 0 && !flags.force) {
    return { allow: false, reason: `gitleaks found ${gitleaksFindings.length} potential secret${gitleaksFindings.length === 1 ? '' : 's'}; use --force to override` };
  }

  if (visibility === 'public' && !flags.publicOk) {
    return { allow: false, reason: 'public repository requires --public-ok before posting agents-trace gist URL' };
  }

  if (visibility === 'unknown' && !flags.publicOk) {
    return { allow: false, reason: 'unknown repository visibility requires --public-ok before posting agents-trace gist URL' };
  }

  if (flags.noAttach && action === 'reattach') {
    return { allow: false, reason: '--no-attach is incompatible with re-attach' };
  }

  return { allow: true, reason: 'posting permitted' };
}
