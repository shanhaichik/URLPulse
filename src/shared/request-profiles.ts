export type RequestSecretInput = { value: string } | { environment: string };
export type RequestProfileChoice = number | null | 'inherit';

export interface RequestHeaderInput {
  name: string;
  secret: boolean;
  value?: string;
  environment?: string;
}

export type RequestAuthInput = { kind: 'none' }
  | { kind: 'basic'; username: string; secret?: RequestSecretInput }
  | { kind: 'bearer'; secret?: RequestSecretInput }
  | { kind: 'api-key'; header: string; secret?: RequestSecretInput };

export interface RequestProfileInput {
  name: string;
  origin: string;
  isDefault: boolean;
  headers: RequestHeaderInput[];
  auth: RequestAuthInput;
  proxy: { url: string; auth?: { username: string; secret?: RequestSecretInput } } | null;
}

export type RequestSecretView = { configured: boolean; environment?: string };
export type RequestHeaderView = { name: string; secret: false; value: string }
  | ({ name: string; secret: true } & RequestSecretView);
export type RequestAuthView = { kind: 'none' }
  | ({ kind: 'basic'; username: string } & RequestSecretView)
  | ({ kind: 'bearer' } & RequestSecretView)
  | ({ kind: 'api-key'; header: string } & RequestSecretView);

export interface RequestProfileView {
  id: number;
  name: string;
  origin: string;
  isDefault: boolean;
  headers: RequestHeaderView[];
  auth: RequestAuthView;
  proxy: { url: string; auth?: { username: string } & RequestSecretView } | null;
}

export interface RequestProfilesView {
  profiles: RequestProfileView[];
  secretMode: 'desktop' | 'environment';
}

export interface ResolvedRequestOptions {
  profileName: string;
  origin: string;
  headers: Record<string, string>;
  protectedValues: string[];
  proxy?: { url: string; authorization?: string };
}
