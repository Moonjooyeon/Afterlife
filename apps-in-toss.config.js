// 앱인토스 빌드 설정. appName은 토스 콘솔에 등록한 앱 이름으로 바꿉니다.
export default {
  appName: 'afterlife',
  brand: {
    primaryColor: '#8c3a2e'
  },
  permissions: [
    { name: 'photos', access: 'write' }
  ],
  navigationBar: {
    withBackButton: true,
    withHomeButton: false,
    withTitle: true,
    theme: 'light'
  },
  webView: {
    allowsBackForwardNavigationGestures: true,
    pullToRefreshEnabled: false,
    overScrollMode: 'content'
  },
  webBundleDir: 'frontend/dist'
};
