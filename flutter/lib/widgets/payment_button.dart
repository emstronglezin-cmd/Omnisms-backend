/// OmniSMS — PaymentButton
///
/// Bouton "Passer Premium" à insérer dans n'importe quel écran.
/// Ouvre le sélecteur de méthode de paiement au clic.
///
/// Usage minimal :
///   PaymentButton(onSuccess: () => setState(() => _isPremium = true))
///
/// Usage compact :
///   PaymentButton(compact: true, onSuccess: () => ...)

import 'package:flutter/material.dart';
import 'payment_method_selector.dart';

class PaymentButton extends StatelessWidget {
  final VoidCallback? onSuccess;
  final String?       fusionLinkUrl;
  final String        label;
  final bool          compact;

  const PaymentButton({
    super.key,
    this.onSuccess,
    this.fusionLinkUrl,
    this.label   = 'Passer Premium — 2 000 XOF',
    this.compact = false,
  });

  static const _accent = Color(0xFF1f6feb);

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return OutlinedButton.icon(
        style: OutlinedButton.styleFrom(
          foregroundColor: _accent,
          side : const BorderSide(color: _accent),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
        icon    : const Icon(Icons.star, size: 16),
        label   : Text(label, style: const TextStyle(fontSize: 13)),
        onPressed: () => _open(context),
      );
    }

    return SizedBox(
      width : double.infinity,
      height: 52,
      child: ElevatedButton.icon(
        style: ElevatedButton.styleFrom(
          backgroundColor: _accent,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          elevation  : 4,
          shadowColor: _accent.withOpacity(0.35),
        ),
        icon    : const Icon(Icons.sms, size: 19),
        label   : Text(label,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
        onPressed: () => _open(context),
      ),
    );
  }

  void _open(BuildContext context) {
    showPaymentSelector(
      context,
      onSuccess    : onSuccess,
      fusionLinkUrl: fusionLinkUrl,
    );
  }
}
