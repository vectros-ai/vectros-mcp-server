/**
 * Optional BYO-provider routing, shared by the inference tools.
 *
 * `providerAlias` sends ONE call through the model provider config your account has activated instead of the
 * platform-hosted default. It is an opt-in input: a tool forwards it only when the caller supplies it, never
 * fills it in, and leaves the platform's own checks to accept or refuse the call.
 */
import { z } from 'zod';

export const providerAliasInput = z
  .string()
  .min(1, 'providerAlias must be non-empty when supplied')
  .optional()
  .describe(
    'Route THIS call through your own model provider instead of the platform-hosted default, by the alias of a ' +
      'provider config your account has activated. It works only after your account has set up that provider and ' +
      'signed the platform\'s risk-acceptance waiver; without both, the platform refuses the call with a 403, which ' +
      'is returned to you as written. When the waiver is the cause, the 403 carries an `errorCode` that says which case it is: ' +
      '`WAIVER_NOT_SIGNED` (the waiver has not been signed), `WAIVER_TEXT_CHANGED` (it was signed, but its text changed ' +
      'afterwards, so the earlier signature no longer counts), or `WAIVER_REVOKED` (an owner revoked it). ' +
      'An account owner resolves each in the developer portal (Model Providers); retrying the call does not help. If your account has accepted the Business Associate Agreement with Vectros in the developer portal, an account ' +
      'owner must also have attested that provider config in the developer portal (Model Providers); until then the ' +
      'platform refuses the call with a 403 that says it needs a BAA-holder attestation. A call served by your own provider leaves the Vectros perimeter. ' +
      'Omit it (the default) to use the platform-hosted path. When set, `model` names the model on your provider\'s ' +
      'own id space, and falls back to that provider config\'s default model when omitted.',
  );
