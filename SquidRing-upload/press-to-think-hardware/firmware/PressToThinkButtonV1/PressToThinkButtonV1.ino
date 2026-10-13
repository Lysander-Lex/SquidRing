#include <Adafruit_TinyUSB.h>
#include <bluefruit.h>

// 按钮接线：D1 ---- 按钮 ---- GND
// 使用 INPUT_PULLUP：松开为 HIGH，按下为 LOW。
constexpr uint8_t BUTTON_PIN = D1;
constexpr uint32_t DEBOUNCE_MS = 25;

BLEDis deviceInfo;
BLEHidAdafruit keyboard;

bool lastRawState = HIGH;
bool stableState = HIGH;
uint32_t lastRawChangeAt = 0;

void startAdvertising() {
  Bluefruit.Advertising.stop();
  Bluefruit.Advertising.clearData();
  Bluefruit.ScanResponse.clearData();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addAppearance(BLE_APPEARANCE_HID_KEYBOARD);
  Bluefruit.Advertising.addService(keyboard);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  delay(200);

  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName("PressToThink Ring V1.0");

  deviceInfo.setManufacturer("Press to Think");
  deviceInfo.setModel("Ring Button Prototype V1.0");
  deviceInfo.begin();

  keyboard.begin();
  startAdvertising();

  Serial.println("PressToThink Ring V1.0 ready");
}

void loop() {
  const bool rawState = digitalRead(BUTTON_PIN);

  if (rawState != lastRawState) {
    lastRawState = rawState;
    lastRawChangeAt = millis();
  }

  if ((millis() - lastRawChangeAt) >= DEBOUNCE_MS && rawState != stableState) {
    stableState = rawState;

    if (stableState == LOW) {
      Serial.println("PTT DOWN");
      if (Bluefruit.connected()) {
        // 保持空格键按下，网页由此开始录音。
        keyboard.keyPress(' ');
      }
    } else {
      Serial.println("PTT UP");
      if (Bluefruit.connected()) {
        // 松开空格键，网页停止录音并提交。
        keyboard.keyRelease();
      }
    }
  }

  delay(2);
}
