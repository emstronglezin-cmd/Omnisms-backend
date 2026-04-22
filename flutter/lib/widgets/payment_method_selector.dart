/// OmniSMS — PaymentMethodSelector
///
/// Widget bottom sheet pour choisir entre :
///  - Fusion Pay (nouveau, intégré dans l'app)
///  - Fusion Link (ancien, ouverture navigateur externe)
///
/// Interroge GET /api/payment/fusion-config pour savoir
/// quelle(s) méthode(s) sont disponibles.
///
/// Usage :
///   showPaymentSelector(context, onSuccess: () => setState(() => _premium = true));

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/payment_fusion_service.dart';
import '../screens/payment_fusion_screen.dart';

// ─── Couleurs OmniSMS ────────────────────────────────────────────
class _C {
  static const bg      = Color(0xFF0d1117);
  static const surface = Color(0xFF161b22);
  static const accent  = Color(0xFF1f6feb);
  static const accentL = Color(0xFF58a6ff);
  static const textM   = Color(0xFFf0f6fc);
  static const textS   = Color(0xFF8b949e);
  static const border  = Color(0xFF30363d);
  static const ok      = Color(0xFF3fb950);
}

class PaymentMethodSelector extends StatefulWidget {
  /// Callback appelé quand l'abonnement est confirmé.
  final VoidCallback? onSuccess;

  /// URL Fusion Link de secours (si backend ne répond pas).
  final String? fusionLinkUrl;

  const PaymentMethodSelector({
    super.key,
    this.onSuccess,
    this.fusionLinkUrl,
  });

  @override
  State<PaymentMethodSelector> createState() => _PaymentMethodSelectorState();
}

class _PaymentMethodSelectorState extends State<PaymentMethodSelector> {
  final _service = PaymentFusionService();

  bool    _loading         = true;
  bool    _fusionPayEnabled = false;
  bool    _fusionLinkEnabled= false;
  String? _fusionLinkUrl;

  @override
  void initState() {
    super.initState();
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    final config = await _service.getPaymentConfig();
    if (!mounted) return;
    setState(() {
      _loading           = false;
      _fusionPayEnabled  = config?.fusionPayEnabled  ?? false;
      _fusionLinkEnabled = config?.fusionLinkEnabled ?? false;
      _fusionLinkUrl     = config?.fusionLinkUrl ?? widget.fusionLinkUrl;
    });
  }

  // ── Ouvrir Fusion Link (ancien) ──────────────────────────────
  Future<void> _openFusionLink() async {
    final url = _fusionLinkUrl ?? widget.fusionLinkUrl;
    if (url == null || url.isEmpty) {
      _snack('Lien de paiement non configuré.');
      return;
    }
    try {
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } catch (_) {
      _snack('Impossible d\'ouvrir le lien de paiement.');
    }
  }

  // ── Ouvrir Fusion Pay (nouveau) ──────────────────────────────
  void _openFusionPay() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => PaymentFusionScreen(
        onPaymentSuccess: () {
          Navigator.of(context).pop();
          widget.onSuccess?.call();
        },
        onPaymentError: (e) => _snack('Erreur: $e'),
      ),
    ));
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content        : Text(msg),
      backgroundColor: const Color(0xFF21262d),
      behavior       : SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color       : _C.bg,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 28),
      child: Column(
        mainAxisSize      : MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Handle
          Center(child: Container(
            width : 38, height: 4,
            margin: const EdgeInsets.only(bottom: 18),
            decoration: BoxDecoration(
              color: _C.border, borderRadius: BorderRadius.circular(2)),
          )),

          // Titre
          const Text('Méthode de paiement',
            style    : TextStyle(color: _C.textM, fontSize: 17, fontWeight: FontWeight.w700),
            textAlign: TextAlign.center),
          const SizedBox(height: 4),
          const Text('OmniSMS Premium — 2 000 XOF',
            style    : TextStyle(color: _C.accentL, fontSize: 13),
            textAlign: TextAlign.center),
          const SizedBox(height: 20),

          if (_loading)
            const Center(child: CircularProgressIndicator(color: _C.accent, strokeWidth: 2))
          else ...[
            // Fusion Pay (nouveau)
            if (_fusionPayEnabled) ...[
              _card(
                icon     : Icons.payment,
                badge    : 'Recommandé',
                badgeClr : _C.ok,
                title    : 'Payer maintenant',
                subtitle : 'Orange Money · Moov Money · Carte',
                desc     : 'Paiement intégré — rapide et sécurisé',
                highlight: true,
                onTap    : _openFusionPay,
              ),
              const SizedBox(height: 10),
            ],

            // Fusion Link (ancien)
            if (_fusionLinkEnabled || widget.fusionLinkUrl != null) ...[
              _card(
                icon     : Icons.link,
                badge    : 'Classique',
                badgeClr : const Color(0xFF6e7681),
                title    : 'Lien de paiement',
                subtitle : 'Orange Money · Moov Money',
                desc     : 'Ouverture dans le navigateur',
                highlight: false,
                onTap    : _openFusionLink,
              ),
              const SizedBox(height: 10),
            ],

            // Aucune méthode
            if (!_fusionPayEnabled && !_fusionLinkEnabled && widget.fusionLinkUrl == null)
              Container(
                padding   : const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color       : _C.surface,
                  border      : Border.all(color: _C.border),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Text(
                  'Aucune méthode de paiement disponible.\nVeuillez réessayer plus tard.',
                  style    : TextStyle(color: _C.textS, fontSize: 13, height: 1.5),
                  textAlign: TextAlign.center,
                ),
              ),
          ],

          const SizedBox(height: 6),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: const [
            Icon(Icons.verified_user, color: _C.ok, size: 13),
            SizedBox(width: 5),
            Text('Paiement sécurisé — Money Fusion',
              style: TextStyle(color: _C.textS, fontSize: 11)),
          ]),
        ],
      ),
    );
  }

  Widget _card({
    required IconData icon,
    required String badge, required Color badgeClr,
    required String title, required String subtitle, required String desc,
    required bool highlight,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding   : const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color       : highlight ? _C.accent.withOpacity(0.08) : _C.surface,
          border      : Border.all(
            color: highlight ? _C.accent.withOpacity(0.45) : _C.border,
            width: highlight ? 1.5 : 1,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(children: [
          Container(
            width : 44, height: 44,
            decoration: BoxDecoration(
              color       : (highlight ? _C.accent : const Color(0xFF30363d)).withOpacity(0.18),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: highlight ? _C.accent : _C.textS, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Text(title,
                  style: const TextStyle(color: _C.textM, fontWeight: FontWeight.w700, fontSize: 14)),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color : badgeClr.withOpacity(0.12),
                    border: Border.all(color: badgeClr.withOpacity(0.3)),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(badge,
                    style: TextStyle(color: badgeClr, fontSize: 9, fontWeight: FontWeight.w700)),
                ),
              ]),
              const SizedBox(height: 2),
              Text(subtitle, style: const TextStyle(color: _C.accentL, fontSize: 11)),
              const SizedBox(height: 2),
              Text(desc, style: const TextStyle(color: _C.textS, fontSize: 11)),
            ],
          )),
          const Icon(Icons.arrow_forward_ios, color: _C.textS, size: 13),
        ]),
      ),
    );
  }
}

// ─── Helper global ───────────────────────────────────────────────
/// Ouvrir le sélecteur de méthode de paiement depuis n'importe où.
Future<void> showPaymentSelector(
  BuildContext context, {
  VoidCallback? onSuccess,
  String? fusionLinkUrl,
}) {
  return showModalBottomSheet<void>(
    context           : context,
    isScrollControlled: true,
    backgroundColor   : Colors.transparent,
    builder: (_) => PaymentMethodSelector(
      onSuccess    : onSuccess,
      fusionLinkUrl: fusionLinkUrl,
    ),
  );
}
