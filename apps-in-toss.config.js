// 앱인토스 빌드 설정. appName은 토스 콘솔에 등록한 값과 반드시 같아야 하고, 콘솔에서 수정할 수 없습니다.
export default {
  appName: 'unread',
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
