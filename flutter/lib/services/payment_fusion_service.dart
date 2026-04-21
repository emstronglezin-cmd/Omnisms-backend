/// OmniSMS — PaymentFusionService
///
/// Service d'intégration Fusion Pay (Money Fusion API) pour OmniSMS.
/// Fonctionne EN PARALLÈLE avec l'ancien système Fusion Link.
///
/// Flux :
///  1. initPayment()       → POST /api/payment/fusion-pay
///  2. Ouvre paymentUrl    → WebView ou url_launcher
///  3. pollPaymentStatus() → GET /api/payment/fusion-status/:token
///  4. listenToSubscription() → Écoute Firestore en temps réel
///  5. Confirmation automatique dès mise à jour Firestore
///
/// Variables de build :
///   --dart-define=BACKEND_URL=https://votre-backend.onrender.com

library payment_fusion_service;

import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';

// ─── Modèles ────────────────────────────────────────────────────

/// Résultat de l'initiation du paiement Fusion Pay.
class FusionPayInitResult {
  final bool success;

  /// URL Money Fusion à ouvrir dans un WebView ou le navigateur.
  final String? paymentUrl;

  /// Token unique pour le polling du statut.
  final String? token;

  /// Identifiant de commande interne.
  final String? orderId;

  /// Message d'erreur (si success == false).
  final String? error;

  /// true si l'utilisateur est déjà abonné.
  final bool alreadySubscribed;

  const FusionPayInitResult({
    required this.success,
    this.paymentUrl,
    this.token,
    this.orderId,
    this.error,
    this.alreadySubscribed = false,
  });
}

/// Statuts possibles d'un paiement.
enum FusionPayStatus {
  pending,    // En attente
  processing, // En cours de traitement
  paid,       // Confirmé et payé
  failed,     // Échoué ou annulé
  unknown,    // Statut inconnu
}

/// Résultat d'une vérification de statut.
class FusionPayStatusResult {
  final FusionPayStatus status;
  final bool isPaid;
  final String? amount;
  final String? moyen;
  final String? error;

  const FusionPayStatusResult({
    required this.status,
    required this.isPaid,
    this.amount,
    this.moyen,
    this.error,
  });
}

/// Configuration des méthodes de paiement disponibles (depuis backend).
class FusionPayConfig {
  final bool fusionPayEnabled;
  final bool fusionLinkEnabled;
  final String? fusionLinkUrl;
  final int amount;
  final String currency;
  final String activeMethod;

  const FusionPayConfig({
    required this.fusionPayEnabled,
    required this.fusionLinkEnabled,
    this.fusionLinkUrl,
    this.amount = 2000,
    this.currency = 'XOF',
    this.activeMethod = 'none',
  });

  factory FusionPayConfig.fromJson(Map<String, dynamic> json) {
    return FusionPayConfig(
      fusionPayEnabled  : json['fusionPayEnabled']  == true,
      fusionLinkEnabled : json['fusionLinkEnabled'] == true,
      fusionLinkUrl     : json['fusionLinkUrl']     as String?,
      amount            : (json['amount']           as num?)?.toInt() ?? 2000,
      currency          : json['currency']          as String? ?? 'XOF',
      activeMethod      : json['activeMethod']      as String? ?? 'none',
    );
  }

  bool get hasAnyMethod => fusionPayEnabled || fusionLinkEnabled;
}

// ─── Service ────────────────────────────────────────────────────

/// Service principal de paiement OmniSMS via Money Fusion.
///
/// Singleton — `PaymentFusionService()` retourne toujours la même instance.
class PaymentFusionService {
  static final PaymentFusionService _instance = PaymentFusionService._internal();
  factory PaymentFusionService() => _instance;
  PaymentFusionService._internal();

  // ── Config ──────────────────────────────────────────────────
  static const String _backendBaseUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'https://votre-backend.onrender.com',
  );

  static const int    premiumAmount = 2000;
  static const String currency      = 'XOF';

  // ── Firebase ────────────────────────────────────────────────
  final FirebaseAuth      _auth      = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  // ── Cache config (5 min) ────────────────────────────────────
  FusionPayConfig? _cachedConfig;
  DateTime?        _configFetchedAt;

  String  get _baseUrl     => _backendBaseUrl;
  String? get currentUserId => _auth.currentUser?.uid;

  // ════════════════════════════════════════════════════════════
  // 1. Initier un paiement
  // ════════════════════════════════════════════════════════════
  /// Appelle le backend pour initier un paiement Fusion Pay.
  ///
  /// [phone]     : Numéro de téléphone (optionnel).
  /// [nomClient] : Nom du client (optionnel).
  ///
  /// Si [success] est true, ouvrez [paymentUrl] dans un WebView.
  Future<FusionPayInitResult> initPayment({
    String? phone,
    String? nomClient,
  }) async {
    final userId = currentUserId;
    if (userId == null) {
      return const FusionPayInitResult(
        success: false,
        error  : 'Vous devez être connecté pour effectuer un paiement.',
      );
    }

    // Vérifier si déjà abonné dans Firestore
    try {
      final doc = await _firestore.collection('users').doc(userId).get();
      if (doc.exists && doc.data()?['isSubscribed'] == true) {
        return const FusionPayInitResult(
          success          : false,
          error            : 'Vous êtes déjà abonné à OmniSMS Premium.',
          alreadySubscribed: true,
        );
      }
    } catch (e) {
      debugPrint('⚠️ [FusionPay] Erreur vérification Firestore: $e');
    }

    try {
      debugPrint('💳 [FusionPay] Initiation paiement | userId=$userId');

      final response = await http.post(
        Uri.parse('$_baseUrl/api/payment/fusion-pay'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'userId' : userId,
          'montant': premiumAmount,
          'devise' : currency,
          if (phone     != null && phone.isNotEmpty)     'phone'    : phone,
          if (nomClient != null && nomClient.isNotEmpty) 'nomClient': nomClient,
        }),
      ).timeout(const Duration(seconds: 20));

      final data = jsonDecode(response.body) as Map<String, dynamic>;

      if (response.statusCode == 200 && data['success'] == true) {
        return FusionPayInitResult(
          success   : true,
          paymentUrl: data['paymentUrl'] as String?,
          token     : data['token']      as String?,
          orderId   : data['orderId']    as String?,
        );
      }

      if (data['alreadySubscribed'] == true) {
        return const FusionPayInitResult(
          success          : false,
          error            : 'Vous êtes déjà abonné à OmniSMS Premium.',
          alreadySubscribed: true,
        );
      }

      return FusionPayInitResult(
        success: false,
        error  : data['error'] as String? ?? 'Erreur inconnue du serveur.',
      );

    } on TimeoutException {
      return const FusionPayInitResult(
        success: false,
        error  : 'Délai dépassé. Vérifiez votre connexion Internet.',
      );
    } catch (e) {
      debugPrint('❌ [FusionPay] Exception: $e');
      return FusionPayInitResult(success: false, error: 'Erreur réseau : $e');
    }
  }

  // ════════════════════════════════════════════════════════════
  // 2. Vérifier le statut d'un paiement (one-shot)
  // ════════════════════════════════════════════════════════════
  /// Vérifie le statut d'un paiement identifié par [token].
  Future<FusionPayStatusResult> checkPaymentStatus(String token) async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/api/payment/fusion-status/${Uri.encodeComponent(token)}'),
      ).timeout(const Duration(seconds: 15));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return FusionPayStatusResult(
          status: _parseStatus(data['status'] as String? ?? 'unknown'),
          isPaid: data['isPaid'] == true,
          amount: data['amount']?.toString(),
          moyen : data['moyen'] as String?,
        );
      }

      return const FusionPayStatusResult(
        status: FusionPayStatus.unknown,
        isPaid: false,
      );
    } catch (e) {
      return FusionPayStatusResult(
        status: FusionPayStatus.unknown,
        isPaid: false,
        error : e.toString(),
      );
    }
  }

  // ════════════════════════════════════════════════════════════
  // 3. Polling automatique du statut
  // ════════════════════════════════════════════════════════════
  /// Poll le statut toutes les [intervalSeconds] secondes,
  /// pour un maximum de [maxAttempts] tentatives (~2 min avec 4s).
  ///
  /// Le stream se termine dès que le paiement est paid ou failed.
  Stream<FusionPayStatusResult> pollPaymentStatus({
    required String token,
    int intervalSeconds = 4,
    int maxAttempts     = 30,
  }) async* {
    for (var i = 0; i < maxAttempts; i++) {
      await Future<void>.delayed(Duration(seconds: intervalSeconds));

      final result = await checkPaymentStatus(token);
      yield result;

      if (result.isPaid || result.status == FusionPayStatus.failed) {
        debugPrint('🏁 [FusionPay] Polling terminé | status=${result.status}');
        break;
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // 4. Écoute Firestore en temps réel
  // ════════════════════════════════════════════════════════════
  /// Stream Firestore — émet true dès que l'abonnement est activé.
  ///
  /// Le backend met à jour `users/{userId}.isSubscribed` via le webhook.
  /// Plus réactif que le polling.
  Stream<bool> listenToSubscription([String? userId]) {
    final uid = userId ?? currentUserId;
    if (uid == null) return Stream.value(false);

    return _firestore
        .collection('users')
        .doc(uid)
        .snapshots()
        .map((snap) => snap.exists && snap.data()?['isSubscribed'] == true)
        .handleError((Object e) {
          debugPrint('⚠️ [FusionPay] Erreur stream Firestore: $e');
          return false;
        });
  }

  // ════════════════════════════════════════════════════════════
  // 5. Vérifier si l'utilisateur est abonné (one-shot)
  // ════════════════════════════════════════════════════════════
  /// Vérifie directement dans Firestore si [userId] est abonné.
  Future<bool> isUserSubscribed(String userId) async {
    try {
      // Via le backend (source de vérité)
      final response = await http.get(
        Uri.parse('$_baseUrl/api/payment/fusion-user/${Uri.encodeComponent(userId)}'),
      ).timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data['isSubscribed'] == true;
      }
    } catch (e) {
      debugPrint('⚠️ [FusionPay] Backend inaccessible, fallback Firestore: $e');
    }

    // Fallback direct Firestore
    try {
      final doc = await _firestore.collection('users').doc(userId).get();
      return doc.exists && doc.data()?['isSubscribed'] == true;
    } catch (e) {
      debugPrint('⚠️ [FusionPay] Erreur Firestore: $e');
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  // 6. Configuration backend (méthodes disponibles)
  // ════════════════════════════════════════════════════════════
  /// Charge la config depuis GET /api/payment/fusion-config.
  /// Mis en cache 5 minutes.
  Future<FusionPayConfig?> getPaymentConfig({bool forceRefresh = false}) async {
    final now = DateTime.now();
    if (!forceRefresh &&
        _cachedConfig != null &&
        _configFetchedAt != null &&
        now.difference(_configFetchedAt!).inMinutes < 5) {
      return _cachedConfig;
    }

    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/api/payment/fusion-config'),
      ).timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        _cachedConfig    = FusionPayConfig.fromJson(
          jsonDecode(response.body) as Map<String, dynamic>);
        _configFetchedAt = now;
        return _cachedConfig;
      }
    } catch (e) {
      debugPrint('⚠️ [FusionPay] Impossible de charger la config: $e');
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════
  // 7. URL Fusion Link (ancien système)
  // ════════════════════════════════════════════════════════════
  /// Récupère l'URL Fusion Link depuis GET /api/payment/fusion-link-url.
  Future<String?> getFusionLinkUrl() async {
    final config = await getPaymentConfig();
    if (config?.fusionLinkUrl != null) return config!.fusionLinkUrl;

    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/api/payment/fusion-link-url'),
      ).timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        return (jsonDecode(response.body) as Map<String, dynamic>)['url'] as String?;
      }
    } catch (e) {
      debugPrint('⚠️ [FusionPay] Impossible de récupérer Fusion Link: $e');
    }
    return null;
  }

  // ── Helper ──────────────────────────────────────────────────
  FusionPayStatus _parseStatus(String s) {
    switch (s.toLowerCase().trim()) {
      case 'paid'       : return FusionPayStatus.paid;
      case 'pending'    : return FusionPayStatus.pending;
      case 'processing' : return FusionPayStatus.processing;
      case 'failed'     :
      case 'failure'    :
      case 'no paid'    :
      case 'cancelled'  : return FusionPayStatus.failed;
      default           : return FusionPayStatus.unknown;
    }
  }
}
