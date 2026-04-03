use std::sync::Arc;

use josekit::jwe::JweDecrypter;
use josekit::jwk::{Jwk, JwkSet};
use josekit::jws::JwsVerifier;
use josekit::{jwe, jws, Value};

pub struct JwksVerifierPool {
  keys: Vec<Arc<Jwk>>,
}

impl JwksVerifierPool {
  pub fn from_jwks(jwks_json: &str) -> Result<Self, String> {
    let jwks =
      JwkSet::from_bytes(jwks_json.as_bytes()).map_err(|e| format!("invalid jwt.jwks: {e}"))?;

    let keys = jwks
      .keys()
      .into_iter()
      .cloned()
      .map(Arc::new)
      .collect::<Vec<_>>();

    if keys.is_empty() {
      return Err("middleware jwt.jwks cannot be empty".to_string());
    }

    Ok(Self { keys })
  }

  pub fn verifiers_for(
    &self,
    alg: &str,
    kid: Option<&str>,
  ) -> Result<Vec<Arc<dyn JwsVerifier>>, String> {
    let candidates = self.candidate_keys(kid)?;
    let verifiers = candidates
      .iter()
      .filter_map(|jwk| create_verifier(alg, jwk.as_ref()))
      .collect::<Vec<_>>();

    if verifiers.is_empty() {
      return Err(format!("jwt alg not supported by jwks keys: {alg}"));
    }

    Ok(verifiers)
  }

  pub fn decrypters_for(
    &self,
    alg: &str,
    kid: Option<&str>,
  ) -> Result<Vec<Arc<dyn JweDecrypter>>, String> {
    let candidates = self.candidate_keys(kid)?;
    let decrypters = candidates
      .iter()
      .filter_map(|jwk| create_decrypter(alg, jwk.as_ref()))
      .collect::<Vec<_>>();

    if decrypters.is_empty() {
      return Err(format!("jwe alg not supported by jwks keys: {alg}"));
    }

    Ok(decrypters)
  }

  fn candidate_keys(&self, kid: Option<&str>) -> Result<Vec<&Arc<Jwk>>, String> {
    let candidates = self
      .keys
      .iter()
      .filter(|jwk| match kid {
        Some(expected) => jwk.key_id() == Some(expected),
        None => true,
      })
      .collect::<Vec<_>>();

    if candidates.is_empty() {
      if let Some(kid) = kid {
        return Err(format!("jwt kid not found in jwks: {kid}"));
      }
      return Err("no jwks key available for token".to_string());
    }

    Ok(candidates)
  }
}

fn create_verifier(alg: &str, jwk: &Jwk) -> Option<Arc<dyn JwsVerifier>> {
  let verifier: Arc<dyn JwsVerifier> = match alg {
    "HS256" => Arc::new(jws::HS256.verifier_from_jwk(jwk).ok()?),
    "HS384" => Arc::new(jws::HS384.verifier_from_jwk(jwk).ok()?),
    "HS512" => Arc::new(jws::HS512.verifier_from_jwk(jwk).ok()?),
    "RS256" => Arc::new(jws::RS256.verifier_from_jwk(jwk).ok()?),
    "RS384" => Arc::new(jws::RS384.verifier_from_jwk(jwk).ok()?),
    "RS512" => Arc::new(jws::RS512.verifier_from_jwk(jwk).ok()?),
    "PS256" => Arc::new(jws::PS256.verifier_from_jwk(jwk).ok()?),
    "PS384" => Arc::new(jws::PS384.verifier_from_jwk(jwk).ok()?),
    "PS512" => Arc::new(jws::PS512.verifier_from_jwk(jwk).ok()?),
    "ES256" => Arc::new(jws::ES256.verifier_from_jwk(jwk).ok()?),
    "ES384" => Arc::new(jws::ES384.verifier_from_jwk(jwk).ok()?),
    "ES512" => Arc::new(jws::ES512.verifier_from_jwk(jwk).ok()?),
    "ES256K" => Arc::new(jws::ES256K.verifier_from_jwk(jwk).ok()?),
    "EdDSA" => Arc::new(jws::EdDSA.verifier_from_jwk(jwk).ok()?),
    _ => return None,
  };

  Some(verifier)
}

fn create_decrypter(alg: &str, jwk: &Jwk) -> Option<Arc<dyn JweDecrypter>> {
  let decrypter: Arc<dyn JweDecrypter> = match alg {
    "dir" => Arc::new(jwe::Dir.decrypter_from_jwk(jwk).ok()?),
    "RSA-OAEP" => Arc::new(jwe::RSA_OAEP.decrypter_from_jwk(jwk).ok()?),
    "RSA-OAEP-256" => Arc::new(jwe::RSA_OAEP_256.decrypter_from_jwk(jwk).ok()?),
    "RSA-OAEP-384" => Arc::new(jwe::RSA_OAEP_384.decrypter_from_jwk(jwk).ok()?),
    "RSA-OAEP-512" => Arc::new(jwe::RSA_OAEP_512.decrypter_from_jwk(jwk).ok()?),
    "A128KW" => Arc::new(jwe::A128KW.decrypter_from_jwk(jwk).ok()?),
    "A192KW" => Arc::new(jwe::A192KW.decrypter_from_jwk(jwk).ok()?),
    "A256KW" => Arc::new(jwe::A256KW.decrypter_from_jwk(jwk).ok()?),
    "A128GCMKW" => Arc::new(jwe::A128GCMKW.decrypter_from_jwk(jwk).ok()?),
    "A192GCMKW" => Arc::new(jwe::A192GCMKW.decrypter_from_jwk(jwk).ok()?),
    "A256GCMKW" => Arc::new(jwe::A256GCMKW.decrypter_from_jwk(jwk).ok()?),
    "ECDH-ES" => Arc::new(jwe::ECDH_ES.decrypter_from_jwk(jwk).ok()?),
    "ECDH-ES+A128KW" => Arc::new(jwe::ECDH_ES_A128KW.decrypter_from_jwk(jwk).ok()?),
    "ECDH-ES+A192KW" => Arc::new(jwe::ECDH_ES_A192KW.decrypter_from_jwk(jwk).ok()?),
    "ECDH-ES+A256KW" => Arc::new(jwe::ECDH_ES_A256KW.decrypter_from_jwk(jwk).ok()?),
    _ => return None,
  };

  Some(decrypter)
}

pub fn read_alg_kid(token: &str) -> Result<(String, Option<String>), String> {
  let header =
    josekit::jwt::decode_header(token).map_err(|e| format!("jwt decode header failed: {e}"))?;
  let alg = header
    .claim("alg")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "jwt header missing alg".to_string())?
    .to_string();
  let kid = header.claim("kid").and_then(|v| match v {
    Value::String(s) => Some(s.clone()),
    _ => None,
  });

  Ok((alg, kid))
}
