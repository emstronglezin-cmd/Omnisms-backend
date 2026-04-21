/// OmniSMS — PaymentFusionScreen
///
/// Écran de paiement Fusion Pay avec WebView intégré.
/// Fonctionne EN PARALLÈLE avec l'ancien système Fusion Link.
///
/// Flux UX :
///   idle    → Formulaire (téléphone optionnel)
///   loading → Appel backend en cours
///   webview → WebView Money Fusion plein écran
///   polling → Vérification du statut de paiement
///   success → Confirmation (abonnement activé)
///   error   → Message d'erreur + bouton réessayer
///
/// Usage :
///   Navigator.push(context,
///     MaterialPageRoute(builder: (_) => const PaymentFusionScreen()));

library payment_fusion_screen;

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../services/payment_fusion_service.dart';

// ─── États ──────────────────────────────────────────────────────
enum _State { idle, loading, webview, polling, success, error }

// ─── Couleurs OmniSMS ────────────────────────────────────────────
class _C {
  static const bg      = Color(0xFF0d1117);
  static const surface = Color(0xFF161b22);
  static const accent  = Color(0xFF1f6feb);
  static const accentL = Color(0xFF58a6ff);
  static const textM   = Color(0xFFf0f6fc);
  static const textS   = Color(0xFF8b949e);
  static const ok      = Color(0xFF3fb950);
  static const err     = Color(0xFFf85149);
  static const border  = Color(0xFF30363d);
}

// ─── Écran ───────────────────────────────────────────────────────
class PaymentFusionScreen extends StatefulWidget {
  /// Appelé quand le paiement est confirmé avec succès.
  final VoidCallback? onPaymentSuccess;

  /// Appelé en cas d'erreur.
  final void Function(String error)? onPaymentError;

  const PaymentFusionScreen({
    super.key,
    this.onPaymentSuccess,
    this.onPaymentError,
  });

  @override
  State<PaymentFusionScreen> createState() => _PaymentFusionScreenState();
}

class _PaymentFusionScreenState extends State<PaymentFusionScreen>
    with TickerProviderStateMixin {

  final _service = PaymentFusionService();

  _State  _state   = _State.idle;
  String? _errorMsg;
  String? _token;

  WebViewController?                         _webCtrl;
  StreamSubscription<FusionPayStatusResult>? _pollSub;
  StreamSubscription<bool>?                  _firestoreSub;
  late final AnimationController             _animCtrl;
  late final Animation<double>               _scaleAnim;

  final _phoneCtrl = TextEditingController();
  final _nameCtrl  = TextEditingController();
  final _formKey   = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    _animCtrl  = AnimationController(vsync: this, duration: const Duration(milliseconds: 600));
    _scaleAnim = CurvedAnimation(parent: _animCtrl, curve: Curves.elasticOut);
    _startFirestoreListener();
  }

  @override
  void dispose() {
    _pollSub?.cancel();
    _firestoreSub?.cancel();
    _animCtrl.dispose();
    _phoneCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  void _startFirestoreListener() {
    _firestoreSub = _service.listenToSubscription().listen((subscribed) {
      if (subscribed && _state != _State.success) _onConfirmed();
    });
  }

  // ── Démarrer le paiement ─────────────────────────────────────
  Future<void> _startPayment() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() { _state = _State.loading; _errorMsg = null; });

    final result = await _service.initPayment(
      phone    : _phoneCtrl.text.trim().isNotEmpty ? _phoneCtrl.text.trim() : null,
      nomClient: _nameCtrl.text.trim().isNotEmpty  ? _nameCtrl.text.trim()  : null,
    );

    if (!mounted) return;

    if (!result.success) {
      setState(() { _state = _State.error; _errorMsg = result.error; });
      widget.onPaymentError?.call(result.error ?? 'Erreur inconnue');
      return;
    }

    _token = result.token;
    _buildWebView(result.paymentUrl!);
    setState(() => _state = _State.webview);
  }

  // ── WebView ──────────────────────────────────────────────────
  void _buildWebView(String url) {
    _webCtrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(_C.bg)
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (req) {
          final uri = req.url;
          if (uri.startsWith('omnisms://payment-return') ||
              uri.contains('/api/payment/fusion-return') ||
              uri.contains('status=success')) {
            _webCtrl = null;
            setState(() => _state = _State.polling);
            if (_token != null) _startPolling(_token!);
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
        onWebResourceError: (e) =>
          debugPrint('⚠️ [WebView] Erreur: ${e.description}'),
      ))
      ..loadRequest(Uri.parse(url));
  }

  // ── Polling ──────────────────────────────────────────────────
  void _startPolling(String token) {
    _pollSub = _service.pollPaymentStatus(
      token: token,
      intervalSeconds: 4,
      maxAttempts    : 30,
    ).listen(
      (result) {
        if (result.isPaid) {
          _pollSub?.cancel();
          _onConfirmed();
        } else if (result.status == FusionPayStatus.failed) {
          _pollSub?.cancel();
          if (mounted) setState(() {
            _state    = _State.error;
            _errorMsg = 'Paiement échoué ou annulé.';
          });
        }
      },
      onDone: () {
        if (_state == _State.polling && mounted) {
          setState(() {
            _state    = _State.error;
            _errorMsg = 'Délai dépassé. Si vous avez payé, '
                       'votre abonnement sera activé sous peu.';
          });
        }
      },
    );
  }

  void _onConfirmed() {
    if (!mounted) return;
    _pollSub?.cancel();
    setState(() => _state = _State.success);
    _animCtrl.forward();
    widget.onPaymentSuccess?.call();
  }

  void _reset() {
    _pollSub?.cancel();
    _webCtrl = null;
    _token   = null;
    _animCtrl.reset();
    setState(() { _state = _State.idle; _errorMsg = null; });
  }

  // ── Build ─────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _C.bg,
      appBar: AppBar(
        backgroundColor: _C.surface,
        foregroundColor: _C.textM,
        elevation      : 0,
        title: Text(
          _appBarTitle(),
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
        ),
        leading: _state == _State.webview
            ? IconButton(
                icon    : const Icon(Icons.close),
                onPressed: _reset,
                tooltip : 'Annuler',
              )
            : null,
      ),
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 280),
        child   : _buildBody(),
      ),
    );
  }

  String _appBarTitle() {
    switch (_state) {
      case _State.webview : return 'Paiement sécurisé';
      case _State.polling : return 'Vérification…';
      case _State.success : return 'Abonnement activé';
      case _State.loading : return 'Chargement…';
      case _State.error   : return 'Erreur';
      default             : return 'OmniSMS Premium';
    }
  }

  Widget _buildBody() {
    switch (_state) {
      case _State.idle    : return _buildIdle();
      case _State.loading : return _buildLoader('Initialisation du paiement…');
      case _State.webview : return _buildWebViewWidget();
      case _State.polling : return _buildLoader('Vérification du paiement…');
      case _State.success : return _buildSuccess();
      case _State.error   : return _buildError();
    }
  }

  // ── Vue formulaire ───────────────────────────────────────────
  Widget _buildIdle() {
    return SingleChildScrollView(
      key    : const ValueKey('idle'),
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
      child  : Form(
        key : _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header
            Column(children: [
              Container(
                width : 72, height: 72,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF1f6feb), Color(0xFF388bfd)],
                    begin : Alignment.topLeft,
                    end   : Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(18),
                  boxShadow: [BoxShadow(
                    color: _C.accent.withOpacity(0.35),
                    blurRadius: 18, offset: const Offset(0, 6),
                  )],
                ),
                child: const Icon(Icons.sms, color: Colors.white, size: 36),
              ),
              const SizedBox(height: 14),
              const Text('OmniSMS Premium',
                style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800, color: _C.textM)),
              const SizedBox(height: 4),
              const Text('Accès illimité – paiement unique 2 000 XOF',
                style: TextStyle(fontSize: 13, color: _C.textS),
                textAlign: TextAlign.center),
            ]),

            const SizedBox(height: 24),

            // Card fonctionnalités
            Container(
              padding   : const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color       : _C.surface,
                border      : Border.all(color: _C.border),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Abonnement à vie',
                        style: TextStyle(color: _C.textM, fontWeight: FontWeight.w700, fontSize: 14)),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(
                          color: _C.accent, borderRadius: BorderRadius.circular(20)),
                        child: const Text('2 000 XOF',
                          style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  for (final f in const [
                    '📱 Envoi SMS illimité',
                    '👥 Groupes & diffusion',
                    '🔒 Accès permanent',
                    '📊 Orange Money · Moov Money · Carte',
                  ])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(f, style: const TextStyle(color: _C.textS, fontSize: 13)),
                    ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // Champ téléphone
            _inputField(
              ctrl        : _phoneCtrl,
              label       : 'Téléphone (optionnel)',
              hint        : '+226 70 00 00 00',
              icon        : Icons.phone,
              inputType   : TextInputType.phone,
              validator   : (v) => (v != null && v.isNotEmpty && v.length < 8)
                  ? 'Numéro invalide' : null,
            ),
            const SizedBox(height: 12),

            // Champ nom
            _inputField(
              ctrl : _nameCtrl,
              label: 'Votre nom (optionnel)',
              hint : 'Ex : Jean Dupont',
              icon : Icons.person,
            ),

            const SizedBox(height: 24),

            // Bouton payer
            ElevatedButton(
              onPressed: _startPayment,
              style    : ElevatedButton.styleFrom(
                backgroundColor: _C.accent,
                foregroundColor: Colors.white,
                padding        : const EdgeInsets.symmetric(vertical: 15),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                elevation  : 4,
                shadowColor: _C.accent.withOpacity(0.4),
              ),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.payment, size: 18),
                  SizedBox(width: 8),
                  Text('Payer 2 000 XOF',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                ],
              ),
            ),

            const SizedBox(height: 14),
            const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.verified_user, color: _C.ok, size: 13),
                SizedBox(width: 6),
                Text('Paiement sécurisé — Money Fusion',
                  style: TextStyle(color: _C.textS, fontSize: 11)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _inputField({
    required TextEditingController ctrl,
    required String label,
    required String hint,
    required IconData icon,
    TextInputType inputType = TextInputType.text,
    String? Function(String?)? validator,
  }) {
    return TextFormField(
      controller  : ctrl,
      keyboardType: inputType,
      style       : const TextStyle(color: _C.textM),
      validator   : validator,
      decoration  : InputDecoration(
        labelText    : label,
        hintText     : hint,
        labelStyle   : const TextStyle(color: _C.textS),
        hintStyle    : const TextStyle(color: Color(0xFF484f58)),
        prefixIcon   : Icon(icon, color: _C.accentL, size: 20),
        filled       : true,
        fillColor    : _C.surface,
        border       : OutlineInputBorder(
          borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide  : const BorderSide(color: _C.border)),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide  : const BorderSide(color: _C.accent)),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide  : const BorderSide(color: _C.err)),
      ),
    );
  }

  // ── Loader ───────────────────────────────────────────────────
  Widget _buildLoader(String msg) {
    return Center(
      key: ValueKey('loader-$msg'),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        const CircularProgressIndicator(color: _C.accent, strokeWidth: 2.5),
        const SizedBox(height: 18),
        Text(msg, style: const TextStyle(color: _C.textS, fontSize: 13)),
      ]),
    );
  }

  // ── WebView ──────────────────────────────────────────────────
  Widget _buildWebViewWidget() {
    if (_webCtrl == null) return _buildLoader('Chargement…');
    return WebViewWidget(key: const ValueKey('wv'), controller: _webCtrl!);
  }

  // ── Succès ───────────────────────────────────────────────────
  Widget _buildSuccess() {
    return Center(
      key: const ValueKey('success'),
      child: ScaleTransition(
        scale: _scaleAnim,
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Container(
              width : 90, height: 90,
              decoration: BoxDecoration(
                color : _C.ok.withOpacity(0.12),
                shape : BoxShape.circle,
                border: Border.all(color: _C.ok, width: 2),
              ),
              child: const Icon(Icons.check, color: _C.ok, size: 46),
            ),
            const SizedBox(height: 22),
            const Text('Abonnement activé ! 🎉',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: _C.textM)),
            const SizedBox(height: 10),
            const Text(
              'OmniSMS Premium est maintenant actif.\n'
              'Profitez de toutes les fonctionnalités.',
              style    : TextStyle(fontSize: 13, color: _C.textS, height: 1.6),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 28),
            ElevatedButton(
              onPressed: () => Navigator.of(context).pop(),
              style    : ElevatedButton.styleFrom(
                backgroundColor: _C.ok,
                foregroundColor: Colors.white,
                padding        : const EdgeInsets.symmetric(horizontal: 28, vertical: 13),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              child: const Text('Continuer', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ]),
        ),
      ),
    );
  }

  // ── Erreur ───────────────────────────────────────────────────
  Widget _buildError() {
    return Center(
      key: const ValueKey('error'),
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Container(
            width : 76, height: 76,
            decoration: BoxDecoration(
              color : _C.err.withOpacity(0.1),
              shape : BoxShape.circle,
              border: Border.all(color: _C.err.withOpacity(0.3)),
            ),
            child: const Icon(Icons.error_outline, color: _C.err, size: 38),
          ),
          const SizedBox(height: 18),
          const Text('Paiement non finalisé',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: _C.textM)),
          const SizedBox(height: 10),
          Text(
            _errorMsg ?? 'Une erreur est survenue.',
            style    : const TextStyle(fontSize: 13, color: _C.textS, height: 1.6),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _reset,
            icon     : const Icon(Icons.refresh, size: 17),
            label    : const Text('Réessayer'),
            style    : ElevatedButton.styleFrom(
              backgroundColor: _C.accent,
              foregroundColor: Colors.white,
              padding        : const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
          ),
          const SizedBox(height: 10),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child    : const Text('Annuler', style: TextStyle(color: _C.textS)),
          ),
        ]),
      ),
    );
  }
}
