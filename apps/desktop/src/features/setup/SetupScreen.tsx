import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { PinPad } from '@/components/PinPad';
import { ApiError, api, type Session } from '@/lib/api';

interface SetupScreenProps {
  shopName: string;
  onDone: (session: Session) => void;
}

type Step = 'shop' | 'pin' | 'confirm';

/**
 * First run. Names the shop and creates the owner's account.
 *
 * Only ever seen once, so it explains rather than assumes: the person doing this
 * is a shop owner setting up software, not an administrator who already knows
 * what a "user account" is. The left panel shows the receipt header taking shape
 * as they type, so the shop details are not an abstract form.
 */
export function SetupScreen({ shopName, onDone }: SetupScreenProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('shop');
  const [shop, setShop] = useState(shopName);
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string>();

  const create = useMutation({
    mutationFn: api.setupOwner,
    onSuccess: onDone,
    onError: () => {
      setStep('pin');
      setPin('');
      setConfirmPin('');
    },
  });

  const error = create.error instanceof ApiError ? create.error : null;
  const detailsReady =
    shop.trim().length >= 2 && fullName.trim().length >= 2 && username.trim().length >= 3;

  function handlePinComplete(entered: string): void {
    setPinError(undefined);
    setPin(entered);
    setStep('confirm');
  }

  function handleConfirmComplete(entered: string): void {
    if (entered !== pin) {
      setPinError('Those PINs are different. Enter the new PIN again.');
      setPin('');
      setConfirmPin('');
      setStep('pin');
      return;
    }
    create.mutate({
      fullName: fullName.trim(),
      username: username.trim().toLowerCase(),
      pin,
      shopName: shop.trim(),
      phone: phone.trim() || undefined,
      addressLine1: address.trim() || undefined,
    });
  }

  return (
    <div className="flex h-full bg-paper">
      <aside className="flex w-96 shrink-0 flex-col justify-between bg-ink p-10 text-white">
        <div>
          <p className="text-meta text-white/45">Every receipt will be headed</p>
          <div className="mt-4 border-l-2 border-board pl-4">
            <p className="text-title font-semibold leading-tight tracking-tight">
              {shop.trim() || 'Your shop name'}
            </p>
            {address.trim() && <p className="mt-1.5 text-base text-white/60">{address.trim()}</p>}
            {phone.trim() && <p className="text-base text-white/60">{phone.trim()}</p>}
          </div>
        </div>
        <Progress step={step} />
      </aside>

      <main className="flex flex-1 items-center justify-center overflow-y-auto p-10">
        <div className="w-full max-w-md">
          <h1 className="text-title font-semibold tracking-tight text-ink">
            {step === 'shop' ? 'Set up the shop' : 'Choose your PIN'}
          </h1>

          {step === 'shop' && (
            <form
              className="mt-7 space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (detailsReady) setStep('pin');
              }}
            >
              <Field
                label="Shop name"
                value={shop}
                onChange={(event) => setShop(event.target.value)}
                autoFocus
                maxLength={80}
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Phone number"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  placeholder="0300 1234567"
                  maxLength={40}
                />
                <Field
                  label="Address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Main Bazaar, Dina"
                  maxLength={120}
                />
              </div>

              <div className="border-t border-rule pt-5">
                <h2 className="text-section font-semibold text-ink">Your account</h2>
                <p className="mt-1 text-meta text-ink-soft">
                  You will be the owner, with access to everything. Add staff later and choose what
                  each of them can do.
                </p>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <Field
                    label="Your name"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    maxLength={60}
                  />
                  <Field
                    label="Username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    hint="Letters and numbers, no spaces."
                    maxLength={32}
                  />
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!detailsReady}
                className="w-full"
              >
                Continue
              </Button>
            </form>
          )}

          {step !== 'shop' && (
            <div className="mt-7">
              <p className="mb-7 text-row text-ink-soft">
                {step === 'pin'
                  ? 'You will type this four-digit PIN every time you sign in. Avoid 1234 and four of the same digit.'
                  : 'Enter the same PIN once more to confirm it.'}
              </p>

              <PinPad
                key={step}
                value={step === 'pin' ? pin : confirmPin}
                onChange={step === 'pin' ? setPin : setConfirmPin}
                onComplete={step === 'pin' ? handlePinComplete : handleConfirmComplete}
                disabled={create.isPending}
                error={pinError ?? error?.message}
              />

              <div className="mt-7 flex items-center gap-3">
                <Button
                  onClick={() => {
                    setPinError(undefined);
                    if (step === 'confirm') {
                      setConfirmPin('');
                      setStep('pin');
                    } else {
                      setPin('');
                      setStep('shop');
                    }
                  }}
                  disabled={create.isPending}
                >
                  Back
                </Button>
                {create.isPending && (
                  <p className="text-meta text-ink-soft">Creating your account…</p>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Two steps, so the owner can see there is an end to this. */
function Progress({ step }: { step: Step }): React.JSX.Element {
  const stage = step === 'shop' ? 0 : 1;
  const labels = ['Shop details', 'Your PIN'];

  return (
    <ol className="space-y-2.5">
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-3">
          <span
            className={[
              'h-1.5 w-8 rounded-full transition-colors duration-200',
              index <= stage ? 'bg-board' : 'bg-white/20',
            ].join(' ')}
          />
          <span className={index <= stage ? 'text-meta text-white/80' : 'text-meta text-white/35'}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
