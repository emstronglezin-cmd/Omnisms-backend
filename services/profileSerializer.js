'use strict';
/**
 * OmniSMS — Sérialisation homogène de la photo de profil.
 *
 * Contrat garanti sur TOUTE réponse contenant un profil :
 *   avatar    : valeur historique (data URI ou URL) — compatibilité PWA
 *   avatarUrl : alias identique — consommé par l'APK
 *   photoUrl  : alias identique — consommé par certains clients
 * Aucune URL relative renvoyée telle quelle : si l'avatar est une URL locale
 * (ex: /uploads/…), elle est rendue ABSOLUE avec BACKEND_URL — un client mobile
 * ne peut pas résoudre une URL relative contre l'origine du backend.
 */

function absolutize(avatar) {
  if (!avatar || typeof avatar !== 'string') return null;
  if (avatar.startsWith('data:') || avatar.startsWith('http://') || avatar.startsWith('https://')) return avatar;
  if (avatar.startsWith('/')) {
    const base = String(process.env.BACKEND_URL || '').replace(/\/+$/, '');
    return base ? `${base}${avatar}` : avatar;
  }
  return avatar;
}

/** Champs de photo normalisés à fusionner dans une réponse de profil. */
function avatarFields(avatar) {
  const v = absolutize(avatar);
  return { avatar: v, avatarUrl: v, photoUrl: v };
}

/** Copie l'objet profil en y fusionnant les champs de photo normalisés. */
function withAvatarFields(profileObj, avatar) {
  if (!profileObj || typeof profileObj !== 'object') return profileObj;
  return { ...profileObj, ...avatarFields(avatar !== undefined ? avatar : profileObj.avatar) };
}

module.exports = { avatarFields, withAvatarFields, absolutize };
