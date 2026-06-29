import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMetaSignup, isAuthenticated } from '@/hooks/useAuth';
import { useFacebookSignup } from '@/hooks/useFacebookSignup';
import { useWhatsAppConfig } from '@/hooks/useWhatsApp';

function FloatingOrb({ size, x, y, delay, color }: { size: number; x: string; y: string; delay: number; color: string }): React.JSX.Element {
  return (
    <motion.div
      animate={{ y: [0, -20, 0], opacity: [0.15, 0.3, 0.15] }}
      transition={{ duration: 8, delay, repeat: Infinity, ease: 'easeInOut' }}
      className="pointer-events-none absolute rounded-full blur-3xl"
      style={{ width: size, height: size, left: x, top: y, background: color }}
    />
  );
}

export default function RegisterPage(): React.JSX.Element {
  const navigate = useNavigate();
  const signup = useMetaSignup();
  const { data: config } = useWhatsAppConfig();
  const enabled = Boolean(config?.embeddedSignupEnabled);
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const { launch: launchSignup, isLoading: launching } = useFacebookSignup({
    config,
    onSuccess: (result) => {
      setSdkError(null);
      signup.mutate(result, {
        onSuccess: () => {
          setSuccess(true);
          navigate('/dashboard', { replace: true });
        },
      });
    },
    onError: (message) => setSdkError(message),
  });

  const busy = signup.isPending || launching;
  const error = sdkError ?? (signup.error instanceof Error ? signup.error.message : null);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0f0f0f] p-4">
      <FloatingOrb size={300} x="-5%" y="-10%" delay={0} color="rgba(61,107,82,0.4)" />
      <FloatingOrb size={250} x="70%" y="60%" delay={2} color="rgba(37,211,102,0.15)" />
      <FloatingOrb size={200} x="20%" y="70%" delay={1} color="rgba(61,107,82,0.25)" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-sm"
      >
        <div className="rounded-2xl border border-[#2a2a2a] bg-[#161616]/70 p-8 backdrop-blur-xl shadow-2xl">
          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.4 }}
                className="flex flex-col items-center gap-4 text-center"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-[#3d6b52]/20 to-[#4d8a68]/10 border border-[#2a2a2a]"
                >
                  <CheckCircle className="h-8 w-8 text-[#22c55e]" />
                </motion.div>
                <div>
                  <h2 className="text-2xl font-semibold text-[#f0f0f0]">You are all set</h2>
                  <p className="mt-2 text-sm text-[#888]">
                    Your WhatsApp Business is connected and your dashboard is ready.
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="mb-8 flex flex-col items-center gap-3">
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.5 }}
                    className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2a2a2a] bg-gradient-to-br from-[#3d6b52]/20 to-[#4d8a68]/10 backdrop-blur-sm"
                  >
                    <svg width="28" height="28" viewBox="0 0 360 362" fill="none">
                      <path
                        fill="#25D366"
                        d="M307.546 52.566C273.709 18.684 228.706.017 180.756 0 81.951 0 1.538 80.404 1.504 179.235c-.017 31.594 8.242 62.432 23.928 89.609L0 361.736l95.024-24.925c26.179 14.285 55.659 21.805 85.655 21.814h.077c98.788 0 179.21-80.413 179.244-179.244.017-47.898-18.608-92.926-52.454-126.807v-.008Zm-126.79 275.788h-.06c-26.73-.008-52.952-7.194-75.831-20.765l-5.44-3.231-56.391 14.791 15.05-54.981-3.542-5.638c-14.912-23.721-22.793-51.139-22.776-79.286.035-82.14 66.867-148.973 149.051-148.973 39.793.017 77.198 15.53 105.328 43.695 28.131 28.157 43.61 65.596 43.593 105.398-.035 82.149-66.867 148.982-148.982 148.982v.008Z"
                      />
                    </svg>
                  </motion.div>
                  <h1 className="text-2xl font-semibold text-[#f0f0f0]">Connect your WhatsApp Business</h1>
                  <p className="text-sm text-[#888]">14-day free trial. No card needed. One Facebook login creates your account and connects your number.</p>
                </div>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => void launchSignup()}
                  disabled={busy || !enabled}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] py-3 text-sm font-semibold text-white transition-all hover:shadow-[0_0_20px_rgba(61,107,82,0.3)] disabled:opacity-50 disabled:hover:shadow-none"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                    </svg>
                  )}
                  Continue with Facebook
                </motion.button>

                {error && (
                  <motion.p
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 text-center text-sm text-[#ef4444]"
                  >
                    {error}
                  </motion.p>
                )}

                {!enabled && !error && (
                  <p className="mt-4 text-center text-xs text-[#555]">
                    Embedded Signup is not configured. Set META_CONFIG_ID on the server to enable it.
                  </p>
                )}

                <p className="mt-6 text-center text-sm text-[#666]">
                  Already have an account?{' '}
                  <Link to="/login" className="font-medium text-[#4d8a68] hover:text-[#3d6b52]">
                    Sign in
                  </Link>
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
