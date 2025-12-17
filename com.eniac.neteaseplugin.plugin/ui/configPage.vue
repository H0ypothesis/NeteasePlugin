<template>
  <v-container class="netease-config">
    <v-card class="mx-auto" max-width="700">
      <v-card-title class="text-h5 netease-header">
        <v-icon class="mr-2">mdi-music-circle</v-icon>
        {{ $t('Config.Title') }}
      </v-card-title>

      <v-stepper v-model="currentStep" :items="stepItems" alt-labels>
        <!-- Step 1: 安装网易云音乐 -->
        <template v-slot:item.1>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step1.Description') }}</p>
              <v-alert type="info" variant="tonal" class="mb-4">
                <pre class="instructions">{{ $t('Config.Step1.Instructions') }}</pre>
              </v-alert>
              
              <v-btn
                color="#E60026"
                variant="elevated"
                @click="openUrl('https://music.163.com/st/download')"
                prepend-icon="mdi-download"
              >
                {{ $t('Config.Step1.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 2: 安装 BetterNCM -->
        <template v-slot:item.2>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step2.Description') }}</p>
              <v-alert type="info" variant="tonal" class="mb-4">
                <pre class="instructions">{{ $t('Config.Step2.Instructions') }}</pre>
              </v-alert>
              
              <v-btn
                color="#E60026"
                variant="elevated"
                @click="openUrl('https://microblock.cc/betterncm')"
                prepend-icon="mdi-open-in-new"
              >
                {{ $t('Config.Step2.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 3: 一键安装插件 -->
        <template v-slot:item.3>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step3.Description') }}</p>
              
              <v-alert
                :type="installStatus === 'success' ? 'success' : (installStatus === 'error' ? 'error' : 'info')"
                variant="tonal"
                class="mb-4"
              >
                <span v-if="installStatus === 'idle'">{{ $t('Config.Step3.Idle') }}</span>
                <span v-else-if="installStatus === 'installing'">{{ $t('Config.Step3.Installing') }}</span>
                <span v-else-if="installStatus === 'success'">{{ $t('Config.Step3.Success') }}</span>
                <span v-else-if="installStatus === 'error'">{{ installError }}</span>
              </v-alert>
              
              <v-btn
                color="#E60026"
                variant="elevated"
                @click="installPlugin"
                :loading="installStatus === 'installing'"
                :disabled="installStatus === 'installing'"
                prepend-icon="mdi-download-circle"
              >
                {{ $t('Config.Step3.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 4: 重启网易云音乐 -->
        <template v-slot:item.4>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step4.Description') }}</p>
              <v-alert type="warning" variant="tonal" class="mb-4">
                <pre class="instructions">{{ $t('Config.Step4.Instructions') }}</pre>
              </v-alert>
              
              <v-icon size="64" color="#E60026" class="d-block mx-auto my-4">
                mdi-restart
              </v-icon>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 5: 连接测试 -->
        <template v-slot:item.5>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step5.Description') }}</p>
              
              <v-alert
                :type="connectionStatus === 'connected' ? 'success' : (connectionStatus === 'error' ? 'error' : 'warning')"
                variant="tonal"
                class="mb-4"
              >
                <div class="d-flex align-center">
                  <span v-if="connectionStatus === 'idle'">{{ $t('Config.Step5.Idle') }}</span>
                  <span v-else-if="connectionStatus === 'testing'">{{ $t('Config.Step5.Testing') }}</span>
                  <span v-else-if="connectionStatus === 'connected'">
                    {{ $t('Config.Step5.Connected') }}
                    <span v-if="currentSong" class="ml-2">- {{ currentSong }}</span>
                  </span>
                  <span v-else-if="connectionStatus === 'error'">{{ $t('Config.Step5.NotConnected') }}</span>
                </div>
              </v-alert>
              
              <v-btn
                color="#E60026"
                variant="elevated"
                @click="testConnection"
                :loading="connectionStatus === 'testing'"
                prepend-icon="mdi-connection"
              >
                {{ $t('Config.Step5.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <template v-slot:actions>
          <v-stepper-actions
            @click:prev="currentStep--"
            @click:next="handleNext"
            :prev-text="$t('Config.Back')"
            :next-text="currentStep === 5 ? $t('Config.Finish') : $t('Config.Next')"
          />
        </template>
      </v-stepper>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'ConfigPage',
  data() {
    return {
      currentStep: 1,
      installStatus: 'idle', // idle, installing, success, error
      installError: '',
      connectionStatus: 'idle', // idle, testing, connected, error
      currentSong: ''
    };
  },
  computed: {
    stepItems() {
      return [
        { title: this.$t('Config.Step1.Title'), value: 1 },
        { title: this.$t('Config.Step2.Title'), value: 2 },
        { title: this.$t('Config.Step3.Title'), value: 3 },
        { title: this.$t('Config.Step4.Title'), value: 4 },
        { title: this.$t('Config.Step5.Title'), value: 5 }
      ];
    }
  },
  methods: {
    async openUrl(url) {
      try {
        await this.$fd.sendToBackend({
          action: 'openUrl',
          url: url
        });
      } catch (error) {
        this.$fd.error('Failed to open URL: ' + error.message);
      }
    },
    async installPlugin() {
      this.installStatus = 'installing';
      this.installError = '';
      
      try {
        const response = await this.$fd.sendToBackend({
          action: 'installBetterNCMPlugin'
        });
        
        if (response && response.success) {
          this.installStatus = 'success';
          this.$fd.info(this.$t('Config.Step3.Success'));
        } else {
          this.installStatus = 'error';
          this.installError = response?.error || this.$t('Config.Step3.Error');
          this.$fd.error(this.installError);
        }
      } catch (error) {
        this.installStatus = 'error';
        this.installError = error.message || this.$t('Config.Step3.Error');
        this.$fd.error(this.installError);
      }
    },
    async testConnection() {
      this.connectionStatus = 'testing';
      
      try {
        const response = await this.$fd.sendToBackend({
          action: 'getConnectionStatus'
        });
        
        if (response && response.connected) {
          this.connectionStatus = 'connected';
          this.currentSong = response.currentSong || '';
          this.$fd.info(this.$t('Config.Step5.Connected'));
        } else {
          this.connectionStatus = 'error';
          this.$fd.error(this.$t('Config.Step5.NotConnected'));
        }
      } catch (error) {
        this.connectionStatus = 'error';
        this.$fd.error(this.$t('Config.Step5.NotConnected'));
      }
    },
    handleNext() {
      if (this.currentStep === 5) {
        // 完成配置
        this.$fd.info(this.$t('Config.Complete'));
        return;
      }
      this.currentStep++;
    },
    async checkInitialConnection() {
      try {
        const response = await this.$fd.sendToBackend({
          action: 'getConnectionStatus'
        });
        
        if (response && response.connected) {
          this.connectionStatus = 'connected';
          this.currentSong = response.currentSong || '';
        }
      } catch (error) {
        // 忽略初始检查错误
      }
    }
  },
  mounted() {
    this.$fd.info('Netease Music Config Page loaded');
    this.checkInitialConnection();
  }
};
</script>

<style scoped>
.netease-config {
  padding: 16px;
}

.netease-header {
  background: linear-gradient(135deg, #E60026 0%, #8B0000 100%);
  color: white;
}

.instructions {
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0;
}

.gap-3 {
  gap: 12px;
}

.mdi-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>

