<template>
  <v-container class="nowplaying-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-cog</v-icon>
        {{ $t('NowPlaying.Title') }}
      </v-card-title>
      
      <v-card-text>
        <v-list density="compact">
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showTitle"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowTitle') }}</v-list-item-title>
          </v-list-item>
          
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showArtist"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowArtist') }}</v-list-item-title>
          </v-list-item>
          
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showAlbum"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowAlbum') }}</v-list-item-title>
          </v-list-item>
          
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showProgress"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowProgress') }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'NowPlayingSettings',
  props: {
    modelValue: {
      type: Object,
      required: true
    }
  },
  emits: ['update:modelValue'],
  methods: {
    emitUpdate() {
      this.$emit('update:modelValue', this.modelValue);
    },
    initDefaults() {
      if (!this.modelValue.data) {
        this.modelValue.data = {};
      }
      if (this.modelValue.data.showTitle === undefined) {
        this.modelValue.data.showTitle = true;
      }
      if (this.modelValue.data.showArtist === undefined) {
        this.modelValue.data.showArtist = true;
      }
      if (this.modelValue.data.showAlbum === undefined) {
        this.modelValue.data.showAlbum = true;
      }
      if (this.modelValue.data.showProgress === undefined) {
        this.modelValue.data.showProgress = true;
      }
    }
  },
  mounted() {
    this.$fd.info('Now Playing settings loaded');
    this.initDefaults();
  }
};
</script>

<style scoped>
.nowplaying-settings {
  padding: 8px;
}
</style>

